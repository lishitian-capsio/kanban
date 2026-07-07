// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed kanban, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import {
	type AgentProviderConfig,
	deleteAgentProvider,
	getAgentExecutablePath,
	getAgentProviderConfig,
	getAllAgentProviderConfigs,
	getAllAgentProviderSets,
	getProviderBypassProxyHosts,
	redactAgentProviderSets,
	saveAgentProvider,
	setAgentExecutablePath,
	setDefaultAgentProvider,
} from "../agent-sdk/kanban/agent-provider-config";
import type { CommittedProviderLayer } from "../agent-sdk/kanban/agent-provider-resolver";
import { createAgentProviderService } from "../agent-sdk/kanban/agent-provider-service";
import { createMcpRuntimeService, type McpRuntimeService } from "../agent-sdk/kanban/mcp-runtime-service";
import { createKanbanMcpSettingsService } from "../agent-sdk/kanban/mcp-settings-service";
import { buildModelsUrl, classifyModelFetchError, extractModelRecords } from "../agent-sdk/kanban/model-discovery";
import { resolvePiLaunchConfig } from "../agent-sdk/kanban/pi-provider-config";
import { buildPiSystemPrompt } from "../agent-sdk/kanban/pi-system-prompt";
import type { PiTaskSessionService } from "../agent-sdk/kanban/pi-task-session-service";
import { isKanbanClearSlashCommand, KANBAN_BUILTIN_SLASH_COMMANDS } from "../agent-sdk/shared/slash-commands";
import { setRuntimeProxyStateFromConfig } from "../config/proxy-fetch";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentExecutablePathResponse,
	RuntimeAgentExecutablePathSaveRequest,
	RuntimeAgentId,
	RuntimeAgentProviderConfigListResponse,
	RuntimeAgentProviderConfigSaveRequest,
	RuntimeAgentProviderMutationRequest,
	RuntimeAgentProviderMutationResponse,
	RuntimeAgentProviderSetListResponse,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeTaskSessionSummary,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseCommandRunRequest,
	parseFetchRemoteModelsRequest,
	parseHomeChatFullscreenTabsSaveRequest,
	parseHomeChatThreadBindImChannelRequest,
	parseHomeChatThreadCloseRequest,
	parseHomeChatThreadCreateRequest,
	parseHomeChatThreadImChannelIdRequest,
	parseHomeChatThreadRenameRequest,
	parseHomeChatThreadSetNextStepRequest,
	parseHomeChatThreadSetTitleRequest,
	parseImChatAddRequest,
	parseImChatRemoveRequest,
	parseKanbanMcpOAuthRequest,
	parseKanbanMcpSettingsSaveRequest,
	parseKanbanProviderModelsRequest,
	parsePiImChannelBindRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskSessionAttachmentRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
	parseWorkspaceAttachmentDeleteFileRequest,
	parseWorkspaceAttachmentDeleteRequest,
	parseWorkspaceAttachmentRequest,
} from "../core/api-validation";
import {
	createHomeAgentSessionId,
	DEFAULT_HOME_THREAD_ID,
	isHomeAgentSessionId,
	parseHomeAgentSessionId,
	resolveHomeAgentId,
} from "../core/home-agent-session";
import { getKanbanRuntimeNoProxyHosts } from "../core/runtime-endpoint";
import { resolveTaskTitle } from "../core/task-title.js";
import { resolveImChatDisplayName } from "../im/im-chat-name-resolver";
import { createLogger } from "../logging";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { limitAgentStart } from "../server/agent-start-limiter";
import { openInBrowser } from "../server/browser";
import { deriveProvisionalThreadTitle } from "../session/home-thread-registry";
import type { HomeThreadStore } from "../session/home-thread-store";
import type { ImChatStore } from "../session/im-chat-store";
import { capChatMessagesForTransport } from "../session/session-message-display-cap";
import { getSelectedCommittedProvider } from "../state/committed-provider-store";
import { loadWorkspaceCommittedProviders } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import {
	deleteAttachmentScope,
	deleteScopeAttachmentFile,
	isValidAttachmentScopeId,
	listAllAttachmentScopes,
	writeScopeAttachment,
} from "../terminal/session-attachment-store";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { materializeTaskAttachmentsIntoPrompt } from "../terminal/task-attachment-launch";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router";

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	getActiveRuntimeConfig?: () => RuntimeConfigState;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedPiTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<PiTaskSessionService>;
	// Per-workspace home chat thread registry backing the home sidebar's parallel threads.
	getScopedHomeThreadStore: (scope: RuntimeTrpcWorkspaceScope) => HomeThreadStore;
	// Per-workspace bindable IM chat list (requirement ac99c) — the palette of 飞书/钉钉
	// conversations a home thread's `imChannel` can point at.
	getScopedImChatStore: (scope: RuntimeTrpcWorkspaceScope) => ImChatStore;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	broadcastKanbanMcpAuthStatusesUpdated?: (
		statuses: Awaited<ReturnType<McpRuntimeService["getAuthStatuses"]>>,
	) => void;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	bumpKanbanSessionContextVersion?: () => void;
	prepareForStateReset?: () => Promise<void>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

/**
 * Build the full pi system prompt for a home (sidebar) agent session.
 * Combines the base pi prompt (senior engineer identity, workspace context,
 * project rules) with the Kanban sidebar append prompt (board management
 * identity and CLI instructions). Returns `undefined` for non-home tasks
 * so they fall through to the default pi system prompt.
 */
async function resolvePiHomeAgentSystemPrompt(taskId: string, cwd: string): Promise<string | undefined> {
	const appendPrompt = await resolveHomeAgentAppendSystemPrompt(taskId);
	if (!appendPrompt) return undefined;
	const basePrompt = buildPiSystemPrompt({ cwd });
	return `${basePrompt}\n\n${appendPrompt}`;
}

/**
 * Resolve the workspace's selected committed provider for `agentId` as the
 * non-secret launch-config layer fed into the shared provider resolver (pi via
 * {@link resolvePiLaunchConfig}, CLI agents via `buildAgentProviderEnv`). Returns
 * null (so resolution falls back to the machine-home settings / defaults) when
 * nothing is selected or the lookup fails.
 */
async function loadSelectedCommittedProvider(
	scope: RuntimeTrpcWorkspaceScope,
	agentId: RuntimeAgentId = "pi",
): Promise<CommittedProviderLayer | null> {
	try {
		const data = await loadWorkspaceCommittedProviders(scope.workspaceId);
		const selected = getSelectedCommittedProvider(data, agentId);
		if (!selected) {
			return null;
		}
		return {
			providerId: selected.providerId,
			modelId: selected.modelId,
			reasoningEffort: selected.reasoningEffort,
		};
	} catch {
		return null;
	}
}

const log = createLogger("runtime-api");

/**
 * (Re)seed the in-process proxy holder from the given runtime config, folding in
 * both the runtime self-hosts and any provider endpoints flagged `bypassProxy`.
 * Called on every proxy-config save AND after any provider mutation, so toggling
 * a provider's "direct connection" recomputes the NO_PROXY set and hot-applies to
 * both outbound paths (in-process fetch + CLI-agent network bridge) with no
 * restart — even for an already-running CLI agent (the bridge re-reads the holder
 * per request). We deliberately do NOT write proxy URLs into process.env: that
 * latches Bun's in-process fetch and breaks live switching (see proxy-fetch.ts).
 */
function applyRuntimeProxyState(config: RuntimeConfigState): void {
	setRuntimeProxyStateFromConfig(
		config.proxyEnabled,
		config.proxyHost,
		config.proxyPort,
		config.proxyUsername,
		config.proxyPassword,
		config.noProxy,
		[...getKanbanRuntimeNoProxyHosts(), ...getProviderBypassProxyHosts()],
	);
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const agentProviderService = createAgentProviderService();
	const kanbanMcpSettingsService = createKanbanMcpSettingsService();
	const mcpRuntimeService = createMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastKanbanMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [join(homedir(), ".kanban")] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(
			runtimeConfig,
			agentProviderService.getAgentProviderSummary("pi"),
			getAgentExecutablePath,
		);

	// Recompute the proxy holder's NO_PROXY set after a provider mutation so a
	// `bypassProxy` toggle takes effect live. The proxy URL itself comes from the
	// active runtime config; the bypass hosts are recomputed from the (global)
	// provider store inside applyRuntimeProxyState. No-op when no active config.
	const refreshProviderProxyBypass = (): void => {
		const activeConfig = deps.getActiveRuntimeConfig?.();
		if (activeConfig) applyRuntimeProxyState(activeConfig);
	};

	const callTaskSessionService = async <T>(
		workspaceScope: RuntimeTrpcWorkspaceScope,
		fn: (service: PiTaskSessionService) => Promise<T>,
	): Promise<T | null> => {
		const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
		return fn(piService);
	};

	// Bound to a named const (rather than `return { … }` directly) so a few methods can
	// call sibling methods — e.g. `createHomeThread` kicks off the thread's first turn via
	// `api.startTaskSession`. The closure is only dereferenced at request time, never during
	// construction, so there is no temporal-dead-zone hazard.
	const api: RuntimeTrpcContext["runtimeApi"] = {
		loadConfig: async (workspaceScope) => {
			const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
			if (!workspaceScope && !activeRuntimeConfig) {
				throw new Error("No active runtime config provider is available.");
			}
			let scopedRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			} else if (activeRuntimeConfig) {
				scopedRuntimeConfig = activeRuntimeConfig;
			} else {
				throw new Error("No active runtime config provider is available.");
			}
			return buildConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			let nextRuntimeConfig: RuntimeConfigState;
			if (workspaceScope) {
				nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			} else {
				const activeRuntimeConfig = deps.getActiveRuntimeConfig?.();
				if (!activeRuntimeConfig) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "No active runtime config is available.",
					});
				}
				nextRuntimeConfig = await updateGlobalRuntimeConfig(activeRuntimeConfig, parsed);
			}
			if (workspaceScope && workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			if (!workspaceScope) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			// Update the in-process proxy holder only (folds in per-provider
			// bypass hosts). Subprocess agents get proxy env at spawn time instead.
			applyRuntimeProxyState(nextRuntimeConfig);
			return buildConfigResponse(nextRuntimeConfig);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				if (body.resumeFromTrash) {
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
				}
				const requestedKanbanTaskMode = body.mode ?? "act";
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: body.taskId,
							baseRef: body.baseRef,
						});
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

				// Per-task config source-of-truth precedence:
				//
				// agentId resolution (which agent runtime to use):
				//   1. previousTerminalAgentId — persisted in the terminal session summary from
				//      the last run; ensures trash-restore resumes with the same agent runtime.
				//   2. body.agentId — the card's current per-task agent override.
				//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
				//
				// agentSettings (which LLM model and reasoning profile the kanban agent uses):
				//   Always taken from the card's current override object. There is no
				//   session-level persistence for these;
				//   if the user changes the model on the card, the next session launch
				//   (including trash-restore) uses the updated values.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const previousTerminalAgentId = body.resumeFromTrash
					? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
					: null;
				// Home (sidebar) sessions encode the per-thread agent in the synthetic
				// task id (`__home_agent__:<ws>:<agent>[:<thread>]`). Each home chat thread
				// can run a different agent than the workspace-global selection, so resolve
				// the agent from the id rather than the workspace default.
				const homeThreadAgentId = resolveHomeAgentId(body.taskId);
				const effectiveAgentId =
					previousTerminalAgentId ?? homeThreadAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				const usePiPath = effectiveAgentId === "pi";

				if (usePiPath) {
					const piLaunchConfig = resolvePiLaunchConfig({
						providerIdOverride: body.agentSettings?.providerId ?? undefined,
						modelIdOverride: body.agentSettings?.modelId ?? undefined,
						reasoningEffortOverride: body.agentSettings?.reasoningEffort ?? undefined,
						committedProvider: await loadSelectedCommittedProvider(workspaceScope),
					});
					const piTaskSessionService = await deps.getScopedPiTaskSessionService(workspaceScope);
					const resolvedPiTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
					const homeAgentSystemPrompt = await resolvePiHomeAgentSystemPrompt(body.taskId, taskCwd);
					// Throttle the spawn + adapter-file-write burst so a bulk start doesn't
					// fire N concurrent process launches at once (host-wide CPU guard).
					const summary = await limitAgentStart(() =>
						piTaskSessionService.startTaskSession({
							taskId: body.taskId,
							cwd: taskCwd,
							prompt: body.prompt,
							taskTitle: resolvedPiTitle.length > 0 ? resolvedPiTitle : undefined,
							images: body.images,
							resumeFromTrash: body.resumeFromTrash,
							providerId: piLaunchConfig.providerId,
							modelId: piLaunchConfig.modelId,
							mode: requestedKanbanTaskMode,
							startInPlanMode: body.startInPlanMode,
							apiKey: piLaunchConfig.apiKey,
							baseUrl: piLaunchConfig.baseUrl,
							reasoningEffort: piLaunchConfig.reasoningEffort,
							systemPrompt: homeAgentSystemPrompt,
						}),
					);

					let nextSummary = summary;
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextSummary = piTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
						} catch {
							// Best effort checkpointing only.
						}
					}

					return {
						ok: true,
						summary: nextSummary,
					};
				}

				const resolvedConfig =
					effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
						? { ...scopedRuntimeConfig, selectedAgentId: effectiveAgentId }
						: scopedRuntimeConfig;
				const resolved = resolveAgentCommand(resolvedConfig, getAgentExecutablePath);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				// Throttle the spawn + adapter-file-write burst so a bulk start doesn't
				// fire N concurrent CLI process launches at once (host-wide CPU guard).
				const committedProvider = await loadSelectedCommittedProvider(workspaceScope, effectiveAgentId);
				// Deferred-write for task-create file attachments: non-image files dropped
				// into the create dialog were staged under the repo root before this task's
				// worktree existed. Now that the worktree (taskCwd) is ready, relocate them
				// into it and append their `@/path` mentions to the kickoff prompt (CLI
				// agents that read mentions only — a no-op otherwise). Home sessions are
				// excluded: their files already live in the repo-root cwd (mention injected
				// at upload), so they must not be routed through the worktree relocate.
				const effectivePrompt = isHomeAgentSessionId(body.taskId)
					? body.prompt
					: await materializeTaskAttachmentsIntoPrompt({
							prompt: body.prompt,
							agentId: effectiveAgentId,
							workspaceRoot: workspaceScope.workspacePath,
							worktreeCwd: taskCwd,
							taskId: body.taskId,
						});
				const summary = await limitAgentStart(() =>
					terminalManager.startTaskSession({
						taskId: body.taskId,
						agentId: resolved.agentId,
						binary: resolved.binary,
						args: resolved.args,
						// Per-session provider selection: the card's agentSettings.providerId
						// picks which of the agent's registered providers to inject. Falls
						// back to the workspace's committed provider for this agent, then the
						// agent's default provider, when unset.
						providerId: body.agentSettings?.providerId ?? undefined,
						committedProvider,
						autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
						cwd: taskCwd,
						prompt: effectivePrompt,
						images: body.images,
						startInPlanMode: body.startInPlanMode,
						resumeFromTrash: body.resumeFromTrash,
						cols: body.cols,
						rows: body.rows,
						workspaceId: workspaceScope.workspaceId,
						proxyEnabled: scopedRuntimeConfig.proxyEnabled,
						proxyHost: scopedRuntimeConfig.proxyHost,
						proxyPort: scopedRuntimeConfig.proxyPort,
						proxyUsername: scopedRuntimeConfig.proxyUsername,
						proxyPassword: scopedRuntimeConfig.proxyPassword,
						noProxy: scopedRuntimeConfig.noProxy,
					}),
				);

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const serviceSummary = await callTaskSessionService(workspaceScope, async (svc) =>
					svc.stopTaskSession(body.taskId),
				);
				if (serviceSummary) {
					return {
						ok: true,
						summary: serviceSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const serviceSummary = await callTaskSessionService(workspaceScope, async (svc) =>
					svc.sendTaskSessionInput(body.taskId, payloadText),
				);
				if (serviceSummary) {
					return {
						ok: true,
						summary: serviceSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
				const summary = piService.getSummary(body.taskId);
				const messages = await piService.loadTaskSessionMessages(body.taskId);
				if (!summary && messages.length === 0) {
					// Fall back to the terminal manager: CLI/terminal agents expose the
					// same agent-agnostic transcript, captured in memory while live.
					const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
					const terminalSummary = terminalManager.getSummary(body.taskId);
					const terminalMessages = await terminalManager.loadTaskSessionMessages(body.taskId);
					if (terminalSummary || terminalMessages.length > 0) {
						return {
							ok: true,
							messages: capChatMessagesForTransport(terminalMessages),
						};
					}
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages: capChatMessagesForTransport(messages),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		getKanbanSlashCommands: async (workspaceScope) => {
			// Builtin commands (e.g. `/clear`) are handled at the send layer
			// (sendTaskChatMessage) rather than by an agent, so they are exposed for
			// the autocomplete here as the single source. The chat composer that
			// queries this is only ever rendered for the native agent (`pi`); terminal
			// agents use the xterm panel instead, so these never surface where they
			// would be ineffective.
			const builtinCommands = KANBAN_BUILTIN_SLASH_COMMANDS.map((command) => ({
				name: command.name,
				description: command.description,
				instructions: "",
			}));
			if (!workspaceScope) {
				return {
					commands: builtinCommands,
				};
			}
			const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
			const builtinNames = new Set(builtinCommands.map((command) => command.name));
			const agentCommands = (await piService.listSlashCommands(workspaceScope.workspacePath)).filter(
				(command) => !builtinNames.has(command.name),
			);
			return {
				commands: [...builtinCommands, ...agentCommands],
			};
		},
		reloadTaskChatSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatReloadRequest(input);
				const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
				let summary = await piService.reloadTaskSession(body.taskId);
				// Only pi-backed home threads reload through the pi service. Terminal
				// threads (claude/codex/...) never trigger this path (they use the
				// terminal panel), but guard on the thread's agent id so a non-pi home
				// session can't be accidentally restarted as pi.
				const reloadHomeAgentId = resolveHomeAgentId(body.taskId);
				if (!summary && reloadHomeAgentId === "pi") {
					const piLaunchConfig = resolvePiLaunchConfig({
						committedProvider: await loadSelectedCommittedProvider(workspaceScope),
					});
					const homeAgentSystemPrompt = await resolvePiHomeAgentSystemPrompt(
						body.taskId,
						workspaceScope.workspacePath,
					);
					summary = await piService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: "",
						resumeFromPersistence: true,
						providerId: piLaunchConfig.providerId,
						modelId: piLaunchConfig.modelId,
						apiKey: piLaunchConfig.apiKey,
						baseUrl: piLaunchConfig.baseUrl,
						reasoningEffort: piLaunchConfig.reasoningEffort,
						systemPrompt: homeAgentSystemPrompt,
					});
				}

				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const summary = await callTaskSessionService(workspaceScope, async (svc) =>
					svc.abortTaskSession(body.taskId),
				);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const summary = await callTaskSessionService(workspaceScope, async (svc) =>
					svc.cancelTaskTurn(body.taskId),
				);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		listHomeThreads: async (workspaceScope) => {
			try {
				const store = deps.getScopedHomeThreadStore(workspaceScope);
				const [threads, fullscreenTabs] = await Promise.all([store.list(), store.getFullscreenTabs()]);
				return { ok: true, threads, fullscreenTabs };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, threads: [], error: message };
			}
		},
		createHomeThread: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadCreateRequest(input);
				// A client-supplied id becomes both a session-id segment (colon-delimited) and
				// an attachments scope directory, so it must be a safe single path segment.
				if (body.id && !isValidAttachmentScopeId(body.id)) {
					return { ok: false, thread: null, error: "Invalid thread id." };
				}
				const agentId = body.agentId ?? (await deps.loadScopedRuntimeConfig(workspaceScope)).selectedAgentId;
				const description = body.description?.trim();
				// A description-seeded thread starts with a provisional `auto` title (a cleaned
				// snippet of the description) that the thread's own agent replaces with a concise
				// summary after its first turn. A legacy name-only thread keeps a PINNED `manual`
				// title and starts no session.
				const titleSource = description ? "auto" : "manual";
				const name = description ? deriveProvisionalThreadTitle(description) : (body.name ?? "");
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).create({
					agentId,
					name,
					titleSource,
					// Honor a client-supplied id so pre-session attachments already written to
					// `.kanban/attachments/<id>/` belong to this thread and are cleaned on close.
					...(body.id ? { id: body.id } : {}),
				});
				// Kick off the thread's first turn with the description as the opening message so
				// the agent both does the requested work and self-titles. Fire-and-forget: the
				// thread is already persisted, so a launch failure must not fail creation (the user
				// can retry by sending a message). Resolving the agent from the synthetic session
				// id is handled inside startTaskSession.
				if (description) {
					const sessionId = createHomeAgentSessionId(workspaceScope.workspaceId, agentId, thread.id);
					void api
						.startTaskSession(workspaceScope, {
							taskId: sessionId,
							prompt: description,
							images: body.images,
							// Home sessions ignore baseRef (they run in the workspace path), but the
							// request schema requires a non-empty string.
							baseRef: "HEAD",
						})
						.catch((error) => {
							log.warn("failed to start home thread session", {
								workspaceId: workspaceScope.workspaceId,
								threadId: thread.id,
								error,
							});
						});
				}
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		renameHomeThread: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadRenameRequest(input);
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).rename(body.id, body.name);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		setHomeThreadTitle: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadSetTitleRequest(input);
				// The synthetic default thread is not a registry entry and its name is a fixed
				// frontend label, so an agent set-title on it is a benign no-op rather than a
				// "thread not found" error. (The self-titling directive is only injected for
				// non-default threads, so this guards against a stray call.)
				if (body.id === DEFAULT_HOME_THREAD_ID) {
					return { ok: true, thread: null };
				}
				const { thread } = await deps.getScopedHomeThreadStore(workspaceScope).setAutoTitle(body.id, body.title);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		setHomeThreadNextStep: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadSetNextStepRequest(input);
				// The synthetic default thread is not a registry entry, so an agent suggest-next on
				// it is a benign no-op (the directive is only injected for non-default threads).
				if (body.id === DEFAULT_HOME_THREAD_ID) {
					return { ok: true, thread: null };
				}
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).setNextStep(body.id, body.suggestion);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		bindHomeThreadImChannel: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadBindImChannelRequest(input);
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).bindImChannel(body.id, body.channel);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		unbindHomeThreadImChannel: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadImChannelIdRequest(input);
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).unbindImChannel(body.id);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		getHomeThreadImChannel: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadImChannelIdRequest(input);
				const imChannel = await deps.getScopedHomeThreadStore(workspaceScope).getImChannel(body.id);
				return { ok: true, imChannel };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, imChannel: null, error: message };
			}
		},
		bindPiImChannel: async (workspaceScope, input) => {
			try {
				const body = parsePiImChannelBindRequest(input);
				const imChannel = await deps.getScopedHomeThreadStore(workspaceScope).bindPiImChannel(body.channel);
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, imChannel };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, imChannel: null, error: message };
			}
		},
		unbindPiImChannel: async (workspaceScope) => {
			try {
				await deps.getScopedHomeThreadStore(workspaceScope).unbindPiImChannel();
				deps.bumpKanbanSessionContextVersion?.();
				return { ok: true, imChannel: null };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, imChannel: null, error: message };
			}
		},
		getPiImChannel: async (workspaceScope) => {
			try {
				const imChannel = await deps.getScopedHomeThreadStore(workspaceScope).getPiImChannel();
				return { ok: true, imChannel };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, imChannel: null, error: message };
			}
		},
		listImChats: async (workspaceScope) => {
			try {
				const chats = await deps.getScopedImChatStore(workspaceScope).list();
				return { ok: true, chats };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, chats: [], error: message };
			}
		},
		addImChat: async (workspaceScope, input) => {
			try {
				const body = parseImChatAddRequest(input);
				// When the caller supplies no label (the picker's raw-id add), best-effort resolve a
				// human-readable name so the palette shows the group/conversation name, not the id.
				const displayName =
					body.displayName?.trim() || (await resolveImChatDisplayName(body.platform, body.chatId)) || undefined;
				const chat = await deps.getScopedImChatStore(workspaceScope).add({ ...body, displayName });
				return { ok: true, chat };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, chat: null, error: message };
			}
		},
		removeImChat: async (workspaceScope, input) => {
			try {
				const body = parseImChatRemoveRequest(input);
				const chat = await deps.getScopedImChatStore(workspaceScope).remove(body.platform, body.chatId);
				return { ok: true, chat };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, chat: null, error: message };
			}
		},
		closeHomeThread: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadCloseRequest(input);
				// close() stops and clears the derived session via the store's onCloseSession hook.
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).close(body.id);
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
			}
		},
		setHomeFullscreenTabs: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatFullscreenTabsSaveRequest(input);
				const fullscreenTabs = await deps.getScopedHomeThreadStore(workspaceScope).setFullscreenTabs(body);
				return { ok: true, fullscreenTabs };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, fullscreenTabs: null, error: message };
			}
		},
		getKanbanProviderCatalog: async (_workspaceScope) => {
			return await agentProviderService.getAllAgentProviderCatalog();
		},
		getKanbanProviderModels: async (_workspaceScope, input) => {
			const body = parseKanbanProviderModelsRequest(input);
			return await agentProviderService.getProviderModels(body.providerId);
		},
		fetchRemoteProviderModels: async (_workspaceScope, input) => {
			const body = parseFetchRemoteModelsRequest(input);
			const url = buildModelsUrl(body.baseUrl, body.protocol);
			const headers: Record<string, string> = { Accept: "application/json" };
			if (body.apiKey) {
				headers.Authorization = `Bearer ${body.apiKey}`;
			}
			// The global fetch is proxy-aware (config/proxy-fetch.ts). A connection-level
			// failure (refused/DNS/TLS/timeout/proxy) otherwise surfaces the runtime's raw
			// native error to the dialog; classify it into an actionable message instead.
			let response: Response;
			try {
				response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15_000) });
			} catch (error) {
				throw new TRPCError({ code: "BAD_REQUEST", message: classifyModelFetchError({ url, error }) });
			}
			if (!response.ok) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: classifyModelFetchError({ url, status: response.status, statusText: response.statusText }),
				});
			}
			const records = extractModelRecords(await response.json());
			return { models: records.map((record) => record.id) };
		},
		getKanbanMcpAuthStatuses: async (_workspaceScope) => {
			const statuses = await mcpRuntimeService.getAuthStatuses();
			return {
				statuses,
			};
		},
		runKanbanMcpServerOAuth: async (_workspaceScope, input) => {
			const body = parseKanbanMcpOAuthRequest(input);
			const response = await mcpRuntimeService.authorizeServer({
				serverName: body.serverName,
				onAuthorizationUrl: (url: string) => {
					openInBrowser(url);
				},
			});
			deps.bumpKanbanSessionContextVersion?.();
			return response;
		},
		getKanbanMcpSettings: async (_workspaceScope) => {
			return kanbanMcpSettingsService.loadSettings();
		},
		saveKanbanMcpSettings: async (_workspaceScope, input) => {
			const body = parseKanbanMcpSettingsSaveRequest(input);
			const response = await kanbanMcpSettingsService.saveSettings(body);
			deps.bumpKanbanSessionContextVersion?.();
			return response;
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const requestedMode = body.mode;

				const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
				if (isKanbanClearSlashCommand(body.text)) {
					const summary = await piService.clearTaskSession(body.taskId);
					deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
					return { ok: true, summary, message: null };
				}

				const isHomeSession = isHomeAgentSessionId(body.taskId);

				// Sending a user message into a home thread starts the agent's next turn, so any
				// pending next-step suggestion is now stale: clear it (best-effort) and bump the
				// session-context version so the sidebar chip disappears for everyone. Scoped to
				// non-default threads (the default thread has no registry entry / suggestion).
				if (isHomeSession) {
					const homeThreadId = parseHomeAgentSessionId(body.taskId)?.threadId;
					if (homeThreadId && homeThreadId !== DEFAULT_HOME_THREAD_ID) {
						try {
							await deps.getScopedHomeThreadStore(workspaceScope).setNextStep(homeThreadId, null);
							deps.bumpKanbanSessionContextVersion?.();
						} catch {
							// A missing thread or transient persistence error must never block sending.
						}
					}
				}

				// Lazily (re)start a home pi chat. The home sidebar starts pi chats
				// lazily on first message, and the live agent can be absent even when a
				// message-store entry lingers (e.g. a prior start failed to leave a live
				// agent, or the session was disposed). Sending into that dead session
				// would throw the internal "No active pi session" error, so start a fresh
				// session here — the message rides along as the start prompt. A genuine
				// launch failure (provider/login/model not configured) still surfaces its
				// own actionable "Pi agent start failed" message rather than the no-session
				// error.
				const startHomePiSession = async (): Promise<RuntimeTaskSessionSummary> => {
					const piLaunchConfig = resolvePiLaunchConfig({
						// Per-session provider override from the composer's provider switch.
						// It outranks the committed-provider/store layers, so this session
						// launches with the chosen provider (and that provider's
						// model/baseUrl/apiKey) without touching the agent default or any
						// other running session.
						providerIdOverride: body.providerId ?? undefined,
						committedProvider: await loadSelectedCommittedProvider(workspaceScope),
					});
					const homeAgentSystemPrompt = await resolvePiHomeAgentSystemPrompt(
						body.taskId,
						workspaceScope.workspacePath,
					);
					return piService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: body.text,
						images: body.images,
						resumeFromPersistence: true,
						providerId: piLaunchConfig.providerId,
						modelId: piLaunchConfig.modelId,
						mode: requestedMode,
						apiKey: piLaunchConfig.apiKey,
						baseUrl: piLaunchConfig.baseUrl,
						reasoningEffort: piLaunchConfig.reasoningEffort,
						systemPrompt: homeAgentSystemPrompt,
					});
				};

				let summary: RuntimeTaskSessionSummary | null;
				if (isHomeSession && !piService.hasActiveAgentSession(body.taskId)) {
					summary = await startHomePiSession();
				} else {
					summary = await piService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images);
				}
				if (!summary) {
					if (!isHomeSession) {
						const rebound = await piService.rebindPersistedTaskSession(body.taskId);
						if (rebound) {
							summary = await piService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images);
						}
						if (!summary) {
							// Fall back to the terminal manager: CLI/terminal agents
							// (claude/codex/...) are not tracked by the pi service, so route
							// the input to the live PTY instead of hard-failing. Mirrors the
							// agent-agnostic fallback already in getTaskChatMessages /
							// sendTaskSessionInput. The text is submitted with a trailing CR.
							const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
							const terminalSummary = terminalManager.writeInput(
								body.taskId,
								Buffer.from(`${body.text}\r`, "utf8"),
							);
							if (terminalSummary) {
								const latestTerminalMessage = terminalManager.listMessages(body.taskId).at(-1) ?? null;
								return {
									ok: true,
									summary: terminalSummary,
									message: latestTerminalMessage,
								};
							}
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						summary = await startHomePiSession();
					}
				}
				const latestMessage = piService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		writeTaskSessionAttachment: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionAttachmentRequest(input);
				// Resolve the CLI agent's actual cwd from its live terminal session. The
				// terminal manager only tracks terminal-backed agents (never pi), so a
				// resolved worktreePath means this is a CLI session — exactly the scope
				// that needs an on-disk file it can `@`-mention.
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const worktreePath = terminalManager.getSummary(body.taskId)?.workspacePath ?? null;
				if (!worktreePath) {
					return { ok: false, error: "No active terminal session for this task." };
				}
				// Isolate attachments per owner: a home-thread session scopes to its
				// threadId, a real task scopes to its taskId. So home threads (which share
				// the repo-root cwd) never mix their files, and each set is cleaned up with
				// its owner (thread close / worktree delete).
				const scopeId = parseHomeAgentSessionId(body.taskId)?.threadId ?? body.taskId;
				const result = await writeScopeAttachment({
					scope: { root: worktreePath, scopeId },
					name: body.name,
					data: body.data,
				});
				return result.ok
					? { ok: true, path: result.path, fileName: result.fileName }
					: { ok: false, error: result.error };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
		writeWorkspaceAttachment: async (workspaceScope, input) => {
			try {
				const body = parseWorkspaceAttachmentRequest(input);
				// The new-thread create dialog has no live session yet, so the file can't
				// be resolved from a terminal session's cwd. A home-thread session runs
				// directly in the workspace repo root (see the home cwd branch in
				// startTaskSession), so write there under the client-supplied scopeId (the
				// future thread id). The injected `@/path` mention resolves once the session
				// starts with cwd = workspacePath, and the files are cleaned up when the
				// thread is closed (or when the dialog is cancelled — see
				// deleteWorkspaceAttachmentScope). The store validates scopeId and caps size.
				const result = await writeScopeAttachment({
					scope: { root: workspaceScope.workspacePath, scopeId: body.scopeId },
					name: body.name,
					data: body.data,
				});
				return result.ok
					? { ok: true, path: result.path, fileName: result.fileName }
					: { ok: false, error: result.error };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
		deleteWorkspaceAttachmentScope: async (workspaceScope, input) => {
			try {
				const body = parseWorkspaceAttachmentDeleteRequest(input);
				// Drop a pre-session upload scope whose thread was never created (dialog
				// cancelled). Home-thread attachments live at the repo root; the store
				// re-validates scopeId before touching disk.
				await deleteAttachmentScope({ root: workspaceScope.workspacePath, scopeId: body.scopeId });
				return { ok: true };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
		listWorkspaceAttachments: async (workspaceScope) => {
			try {
				// The one sanctioned read window into `.kanban`: enumerate the attachment
				// scope dirs under the repo root and enrich each with its home-thread name.
				// Home-thread attachments live at the repo root (see writeWorkspaceAttachment);
				// task attachments live inside their own worktrees, so they never appear here.
				const listings = await listAllAttachmentScopes(workspaceScope.workspacePath);
				const threadNames = new Map<string, string>();
				try {
					const threads = await deps.getScopedHomeThreadStore(workspaceScope).list();
					for (const thread of threads) {
						threadNames.set(thread.id, thread.name);
					}
				} catch (error) {
					// A registry read failure only costs the human-readable names; the raw
					// scopeId is still shown so the surface never fails wholesale.
					log.warn("failed to load home threads for attachment listing", {
						workspaceId: workspaceScope.workspaceId,
						error,
					});
				}
				const scopes = listings.map((listing) => {
					const isDefaultThread = listing.scopeId === DEFAULT_HOME_THREAD_ID;
					return {
						scopeId: listing.scopeId,
						name: threadNames.get(listing.scopeId) ?? (isDefaultThread ? "Home" : null),
						isDefaultThread,
						files: listing.entries.map((entry) => ({
							fileName: entry.fileName,
							// Repo-relative POSIX path so the existing workspaceFs read/download
							// endpoints (which don't block `.kanban` reads) handle preview + download.
							path: `.kanban/attachments/${listing.scopeId}/${entry.fileName}`,
							size: entry.size,
							mtimeMs: entry.mtimeMs,
						})),
					};
				});
				return { ok: true, scopes };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, scopes: [], error: message };
			}
		},
		deleteWorkspaceAttachment: async (workspaceScope, input) => {
			try {
				const body = parseWorkspaceAttachmentDeleteFileRequest(input);
				// Restricted single-file delete: the store refuses any separator/traversal in
				// fileName and only ever removes a direct child of the validated scope dir.
				const result = await deleteScopeAttachmentFile(
					{ root: workspaceScope.workspacePath, scopeId: body.scopeId },
					body.fileName,
				);
				return result.ok ? { ok: true } : { ok: false, error: result.error };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message };
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellScopedConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
					proxyEnabled: shellScopedConfig.proxyEnabled,
					proxyHost: shellScopedConfig.proxyHost,
					proxyPort: shellScopedConfig.proxyPort,
					proxyUsername: shellScopedConfig.proxyUsername,
					proxyPassword: shellScopedConfig.proxyPassword,
					noProxy: shellScopedConfig.noProxy,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
		resetAllState: async (_workspaceScope) => {
			await deps.prepareForStateReset?.();
			await Promise.all(
				debugResetTargetPaths.map(async (path) => {
					await rm(path, { recursive: true, force: true });
				}),
			);
			return {
				ok: true,
				clearedPaths: [...debugResetTargetPaths],
			};
		},
		openFile: async (input) => {
			const filePath = input.filePath.trim();
			if (!filePath) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "File path cannot be empty.",
				});
			}
			openInBrowser(filePath);
			return { ok: true };
		},
		getUpdateStatus: async () => {
			return deps.getUpdateStatus();
		},
		runUpdateNow: async () => {
			return await deps.runUpdateNow();
		},
		listAgentProviderConfigs: async (): Promise<RuntimeAgentProviderConfigListResponse> => {
			// Back-compat shape: the default provider per agent (single-provider view).
			return { agents: getAllAgentProviderConfigs() };
		},
		listAgentProviders: async (): Promise<RuntimeAgentProviderSetListResponse> => {
			// Full multi-provider view: every agent's registered providers + default, secret-free.
			return { agents: redactAgentProviderSets(getAllAgentProviderSets()) };
		},
		saveAgentProviderConfig: async (
			input: RuntimeAgentProviderConfigSaveRequest,
		): Promise<RuntimeAgentProviderMutationResponse> => {
			// Add or update one provider for the agent, keyed by its provider name.
			await saveAgentProvider(input.agentId, input.config as AgentProviderConfig);
			// A changed bypassProxy flag (or endpoint host) must re-seed the holder.
			refreshProviderProxyBypass();
			return {
				ok: true,
				config: getAgentProviderConfig(input.agentId, input.config.provider) ?? undefined,
			};
		},
		addProviderToAgent: async (
			input: RuntimeAgentProviderMutationRequest,
		): Promise<RuntimeAgentProviderMutationResponse> => {
			// Providers are created via saveAgentProviderConfig (which carries the
			// full config); there is nothing to add from an id alone.
			return { ok: true, config: getAgentProviderConfig(input.agentId, input.providerId) ?? undefined };
		},
		removeProviderFromAgent: async (
			input: RuntimeAgentProviderMutationRequest,
		): Promise<RuntimeAgentProviderMutationResponse> => {
			await deleteAgentProvider(input.agentId, input.providerId);
			// Removing a bypassProxy provider may free its host back onto the proxy.
			refreshProviderProxyBypass();
			return { ok: true, config: getAgentProviderConfig(input.agentId) ?? undefined };
		},
		selectAgentProvider: async (
			input: RuntimeAgentProviderMutationRequest,
		): Promise<RuntimeAgentProviderMutationResponse> => {
			// Set the agent's default provider.
			await setDefaultAgentProvider(input.agentId, input.providerId);
			return { ok: true, config: getAgentProviderConfig(input.agentId) ?? undefined };
		},
		setAgentExecutablePath: async (
			input: RuntimeAgentExecutablePathSaveRequest,
		): Promise<RuntimeAgentExecutablePathResponse> => {
			// Persist (or clear, with an empty string) the agent's absolute
			// executable-path override, then report whether the effective binary —
			// the override when set, else the catalog binary on `$PATH` — resolves.
			await setAgentExecutablePath(input.agentId, input.executablePath);
			const persisted = getAgentExecutablePath(input.agentId);
			const catalogBinary = getRuntimeAgentCatalogEntry(input.agentId as RuntimeAgentId)?.binary;
			const effectiveBinary = persisted ?? catalogBinary;
			return {
				ok: true,
				agentId: input.agentId,
				executablePath: persisted ?? null,
				available: effectiveBinary ? isBinaryAvailableOnPath(effectiveBinary) : false,
			};
		},
	};

	return api;
}
