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
	getAgentProviderConfig,
	getAllAgentProviderConfigs,
	getAllAgentProviderSets,
	redactAgentProviderSets,
	saveAgentProvider,
	setDefaultAgentProvider,
} from "../agent-sdk/kanban/agent-provider-config";
import { createAgentProviderService } from "../agent-sdk/kanban/agent-provider-service";
import { createMcpRuntimeService, type McpRuntimeService } from "../agent-sdk/kanban/mcp-runtime-service";
import { createKanbanMcpSettingsService } from "../agent-sdk/kanban/mcp-settings-service";
import { type PiLaunchProfile, resolvePiLaunchConfig } from "../agent-sdk/kanban/pi-provider-config";
import { buildPiSystemPrompt } from "../agent-sdk/kanban/pi-system-prompt";
import type { PiTaskSessionService } from "../agent-sdk/kanban/pi-task-session-service";
import { isKanbanClearSlashCommand } from "../agent-sdk/shared/slash-commands";
import { setRuntimeProxyStateFromConfig } from "../config/proxy-fetch";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeAgentProfile,
	RuntimeAgentProfileListResponse,
	RuntimeAgentProfileMutationResponse,
	RuntimeAgentProfileRecord,
	RuntimeAgentProfilesData,
	RuntimeAgentProviderConfigListResponse,
	RuntimeAgentProviderConfigSaveRequest,
	RuntimeAgentProviderMutationRequest,
	RuntimeAgentProviderMutationResponse,
	RuntimeAgentProviderSetListResponse,
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseAgentProfileCreateRequest,
	parseAgentProfileDeleteRequest,
	parseAgentProfileListRequest,
	parseAgentProfileSelectRequest,
	parseAgentProfileUpdateRequest,
	parseCommandRunRequest,
	parseFetchRemoteModelsRequest,
	parseHomeChatThreadCloseRequest,
	parseHomeChatThreadCreateRequest,
	parseHomeChatThreadRenameRequest,
	parseKanbanAccountSwitchRequest,
	parseKanbanDeviceAuthCompleteRequest,
	parseKanbanMcpOAuthRequest,
	parseKanbanMcpSettingsSaveRequest,
	parseKanbanOauthLoginRequest,
	parseKanbanProviderModelsRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatReloadRequest,
	parseTaskChatSendRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation";
import { isHomeAgentSessionId, resolveHomeAgentId } from "../core/home-agent-session";
import { getKanbanRuntimeNoProxyHosts } from "../core/runtime-endpoint";
import { resolveTaskTitle } from "../core/task-title.js";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { openInBrowser } from "../server/browser";
import type { HomeThreadStore } from "../session/home-thread-store";
import {
	type AgentProfilePatch,
	createAgentProfile,
	deleteAgentProfile,
	getSelectedAgentProfile,
	listAgentProfiles,
	selectAgentProfile,
	updateAgentProfile,
} from "../state/agent-profile-registry";
import { loadWorkspaceAgentProfiles, mutateWorkspaceAgentProfiles } from "../state/workspace-state";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
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
function resolvePiHomeAgentSystemPrompt(taskId: string, cwd: string): string | undefined {
	const appendPrompt = resolveHomeAgentAppendSystemPrompt(taskId);
	if (!appendPrompt) return undefined;
	const basePrompt = buildPiSystemPrompt({ cwd });
	return `${basePrompt}\n\n${appendPrompt}`;
}

function createAgentProfileId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function toAgentProfileSummary(record: RuntimeAgentProfileRecord): RuntimeAgentProfile {
	return record;
}

function buildAgentProfileMutationResponse(
	data: RuntimeAgentProfilesData,
	affected: RuntimeAgentProfileRecord | null,
): RuntimeAgentProfileMutationResponse {
	return {
		profiles: data.profiles.map(toAgentProfileSummary),
		selectedByAgent: data.selectedByAgent,
		profile: affected ? toAgentProfileSummary(affected) : null,
	};
}

/**
 * Resolve the workspace's selected `pi` profile as the non-secret launch-config layer
 * fed into {@link resolvePiLaunchConfig}. Returns null (so resolution falls back to the
 * machine-home settings / defaults) when nothing is selected or the lookup fails.
 */
async function loadSelectedPiLaunchProfile(scope: RuntimeTrpcWorkspaceScope): Promise<PiLaunchProfile | null> {
	try {
		const data = await loadWorkspaceAgentProfiles(scope.workspaceId);
		const selected = getSelectedAgentProfile(data, "pi");
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
		buildRuntimeConfigResponse(runtimeConfig, agentProviderService.getAgentProviderSummary("pi"));

	const callTaskSessionService = async <T>(
		workspaceScope: RuntimeTrpcWorkspaceScope,
		fn: (service: PiTaskSessionService) => Promise<T>,
	): Promise<T | null> => {
		const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
		return fn(piService);
	};

	return {
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
			// Update the in-process proxy holder only. We deliberately do NOT write
			// proxy URLs into process.env: that latches Bun's in-process fetch and
			// breaks live switching/disable (see config/proxy-fetch.ts). Subprocess
			// agents get proxy env at spawn time instead.
			setRuntimeProxyStateFromConfig(
				nextRuntimeConfig.proxyEnabled,
				nextRuntimeConfig.proxyHost,
				nextRuntimeConfig.proxyPort,
				nextRuntimeConfig.proxyUsername,
				nextRuntimeConfig.proxyPassword,
				nextRuntimeConfig.noProxy,
				getKanbanRuntimeNoProxyHosts(),
			);
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
						workspaceProfile: await loadSelectedPiLaunchProfile(workspaceScope),
					});
					const piTaskSessionService = await deps.getScopedPiTaskSessionService(workspaceScope);
					const resolvedPiTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
					const homeAgentSystemPrompt = resolvePiHomeAgentSystemPrompt(body.taskId, taskCwd);
					const summary = await piTaskSessionService.startTaskSession({
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
					});

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
				const resolved = resolveAgentCommand(resolvedConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					// Per-session provider selection: the card's agentSettings.providerId
					// picks which of the agent's registered providers to inject. Falls
					// back to the agent's default provider when unset.
					providerId: body.agentSettings?.providerId ?? undefined,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
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
				});

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
							messages: terminalMessages,
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
					messages,
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
			if (!workspaceScope) {
				return {
					commands: [],
				};
			}
			const piService = await deps.getScopedPiTaskSessionService(workspaceScope);
			return {
				commands: await piService.listSlashCommands(workspaceScope.workspacePath),
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
						workspaceProfile: await loadSelectedPiLaunchProfile(workspaceScope),
					});
					const homeAgentSystemPrompt = resolvePiHomeAgentSystemPrompt(body.taskId, workspaceScope.workspacePath);
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
				const threads = await deps.getScopedHomeThreadStore(workspaceScope).list();
				return { ok: true, threads };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, threads: [], error: message };
			}
		},
		createHomeThread: async (workspaceScope, input) => {
			try {
				const body = parseHomeChatThreadCreateRequest(input);
				const agentId = body.agentId ?? (await deps.loadScopedRuntimeConfig(workspaceScope)).selectedAgentId;
				const thread = await deps.getScopedHomeThreadStore(workspaceScope).create({
					agentId,
					name: body.name,
				});
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
				return { ok: true, thread };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, thread: null, error: message };
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
		listAgentProfiles: async (workspaceScope, input): Promise<RuntimeAgentProfileListResponse> => {
			const body = parseAgentProfileListRequest(input);
			const data = await loadWorkspaceAgentProfiles(workspaceScope.workspaceId);
			return {
				profiles: listAgentProfiles(data, body.agentId).map(toAgentProfileSummary),
				selectedByAgent: data.selectedByAgent,
			};
		},
		createAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
			const body = parseAgentProfileCreateRequest(input);
			const providerId = body.providerId?.trim() || null;
			const id = createAgentProfileId();
			const record: RuntimeAgentProfileRecord = {
				id,
				name: body.name,
				agentId: body.agentId,
				providerId,
				modelId: body.modelId?.trim() || null,
				reasoningEffort: body.reasoningEffort ?? null,
			};
			const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (current) => {
				const created = createAgentProfile(current, record);
				return body.select ? selectAgentProfile(created, body.agentId, id) : created;
			});
			deps.bumpKanbanSessionContextVersion?.();
			return buildAgentProfileMutationResponse(data, data.profiles.find((profile) => profile.id === id) ?? record);
		},
		updateAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
			const body = parseAgentProfileUpdateRequest(input);
			const current = await loadWorkspaceAgentProfiles(workspaceScope.workspaceId);
			const existing = current.profiles.find((profile) => profile.id === body.id);
			if (!existing) {
				throw new TRPCError({ code: "NOT_FOUND", message: `Agent profile "${body.id}" not found.` });
			}
			const patch: AgentProfilePatch = {};
			if (body.name !== undefined) patch.name = body.name;
			if (body.providerId !== undefined) patch.providerId = body.providerId?.trim() || null;
			if (body.modelId !== undefined) patch.modelId = body.modelId?.trim() || null;
			if (body.reasoningEffort !== undefined) patch.reasoningEffort = body.reasoningEffort;
			const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (cur) =>
				updateAgentProfile(cur, body.id, patch),
			);
			deps.bumpKanbanSessionContextVersion?.();
			return buildAgentProfileMutationResponse(
				data,
				data.profiles.find((profile) => profile.id === body.id) ?? null,
			);
		},
		deleteAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
			const body = parseAgentProfileDeleteRequest(input);
			let removed: RuntimeAgentProfileRecord | null = null;
			const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (cur) => {
				const result = deleteAgentProfile(cur, body.id);
				removed = result.removed;
				return result.next;
			});
			deps.bumpKanbanSessionContextVersion?.();
			return buildAgentProfileMutationResponse(data, removed);
		},
		selectAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
			const body = parseAgentProfileSelectRequest(input);
			const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (cur) =>
				selectAgentProfile(cur, body.agentId, body.profileId),
			);
			deps.bumpKanbanSessionContextVersion?.();
			return buildAgentProfileMutationResponse(data, getSelectedAgentProfile(data, body.agentId));
		},
		getKanbanProviderCatalog: async (_workspaceScope) => {
			return await agentProviderService.getAllAgentProviderCatalog();
		},
		getKanbanAccountProfile: async (_workspaceScope) => {
			return await agentProviderService.getKanbanAccountProfile();
		},
		getKanbanKanbanAccess: async (_workspaceScope) => {
			return await agentProviderService.getKanbanKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await agentProviderService.getFeaturebaseToken();
		},
		getKanbanAccountBalance: async (_workspaceScope) => {
			return await agentProviderService.getKanbanAccountBalance();
		},
		getKanbanAccountOrganizations: async (_workspaceScope) => {
			return await agentProviderService.getKanbanAccountOrganizations();
		},
		switchKanbanAccount: async (_workspaceScope, input) => {
			const body = parseKanbanAccountSwitchRequest(input);
			return await agentProviderService.switchKanbanAccount(body.organizationId);
		},
		getKanbanProviderModels: async (_workspaceScope, input) => {
			const body = parseKanbanProviderModelsRequest(input);
			return await agentProviderService.getProviderModels(body.providerId);
		},
		fetchRemoteProviderModels: async (_workspaceScope, input) => {
			const body = parseFetchRemoteModelsRequest(input);
			const modelsPath = body.protocol === "anthropic" ? "/v1/models" : "/models";
			const url = `${body.baseUrl.replace(/\/$/, "")}${modelsPath}`;
			const headers: Record<string, string> = {};
			if (body.apiKey) {
				headers.Authorization = `Bearer ${body.apiKey}`;
			}
			const response = await fetch(url, { headers });
			if (!response.ok) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Failed to fetch models from ${url}: HTTP ${response.status} ${response.statusText}`,
				});
			}
			const data = (await response.json()) as Record<string, unknown>;
			let models: string[] = [];
			if (Array.isArray(data.data)) {
				models = (data.data as Array<{ id?: string }>).map((m) => m.id).filter(Boolean) as string[];
			} else if (Array.isArray(data.models)) {
				models = (data.models as Array<{ id?: string; name?: string }>)
					.map((m) => m.id || m.name)
					.filter(Boolean) as string[];
			}
			return { models };
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
		runKanbanProviderOAuthLogin: async (_workspaceScope, input) => {
			const body = parseKanbanOauthLoginRequest(input);
			const response = await agentProviderService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpKanbanSessionContextVersion?.();
			}
			return response;
		},
		startKanbanDeviceAuth: async () => {
			return await agentProviderService.startDeviceAuth();
		},
		completeKanbanDeviceAuth: async (_workspaceScope, input) => {
			const body = parseKanbanDeviceAuthCompleteRequest(input);
			const response = await agentProviderService.completeDeviceAuth({
				deviceCode: body.deviceCode,
				expiresInSeconds: body.expiresInSeconds,
				pollIntervalSeconds: body.pollIntervalSeconds,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpKanbanSessionContextVersion?.();
			}
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
				let summary = await piService.sendTaskSessionInput(body.taskId, body.text, requestedMode, body.images);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
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
						const piLaunchConfig = resolvePiLaunchConfig({
							workspaceProfile: await loadSelectedPiLaunchProfile(workspaceScope),
						});
						const homeAgentSystemPrompt = resolvePiHomeAgentSystemPrompt(
							body.taskId,
							workspaceScope.workspacePath,
						);
						summary = await piService.startTaskSession({
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
			return { ok: true, config: getAgentProviderConfig(input.agentId) ?? undefined };
		},
		selectAgentProvider: async (
			input: RuntimeAgentProviderMutationRequest,
		): Promise<RuntimeAgentProviderMutationResponse> => {
			// Set the agent's default provider.
			await setDefaultAgentProvider(input.agentId, input.providerId);
			return { ok: true, config: getAgentProviderConfig(input.agentId) ?? undefined };
		},
	};
}
