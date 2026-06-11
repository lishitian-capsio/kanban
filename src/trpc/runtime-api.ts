// Coordinates the runtime-side TRPC handlers used by the browser.
// This is the main backend entrypoint for sessions, settings, git, and
// workspace actions, but detailed kanban, terminal, and config behavior
// should stay in focused services instead of accumulating here.

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { createMcpRuntimeService, type McpRuntimeService } from "../agent-sdk/kanban/mcp-runtime-service";
import { createKanbanMcpSettingsService } from "../agent-sdk/kanban/mcp-settings-service";
import { resolvePiLaunchConfig } from "../agent-sdk/kanban/pi-provider-config";
import type { PiTaskSessionService } from "../agent-sdk/kanban/pi-task-session-service";
import { createProviderService } from "../agent-sdk/kanban/provider-service";
import { isKanbanClearSlashCommand } from "../agent-sdk/shared/slash-commands";
import { applyProxyToProcessEnv } from "../config/proxy-env";
import { setRuntimeProxyStateFromConfig } from "../config/proxy-fetch";
import type { RuntimeConfigState } from "../config/runtime-config";
import { updateGlobalRuntimeConfig, updateRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
} from "../core/api-contract";
import {
	parseCommandRunRequest,
	parseKanbanAccountSwitchRequest,
	parseKanbanAddProviderRequest,
	parseKanbanDeviceAuthCompleteRequest,
	parseKanbanMcpOAuthRequest,
	parseKanbanMcpSettingsSaveRequest,
	parseKanbanOauthLoginRequest,
	parseKanbanProviderModelsRequest,
	parseKanbanProviderSettingsSaveRequest,
	parseKanbanUpdateProviderRequest,
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
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { getKanbanRuntimeNoProxyHosts } from "../core/runtime-endpoint";
import { resolveTaskTitle } from "../core/task-title.js";
import { openInBrowser } from "../server/browser";
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

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	const providerService = createProviderService();
	const kanbanMcpSettingsService = createKanbanMcpSettingsService();
	const mcpRuntimeService = createMcpRuntimeService({
		onAuthStatusesChanged: (statuses) => {
			deps.broadcastKanbanMcpAuthStatusesUpdated?.(statuses);
		},
	});
	const debugResetTargetPaths = [join(homedir(), ".kanban")] as const;

	const buildConfigResponse = (runtimeConfig: RuntimeConfigState) =>
		buildRuntimeConfigResponse(runtimeConfig, providerService.getProviderSettingsSummary());

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
			applyProxyToProcessEnv(
				nextRuntimeConfig.proxyEnabled,
				nextRuntimeConfig.proxyHost,
				nextRuntimeConfig.proxyPort,
				nextRuntimeConfig.proxyUsername,
				nextRuntimeConfig.proxyPassword,
				nextRuntimeConfig.noProxy,
				getKanbanRuntimeNoProxyHosts(),
			);
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
		saveKanbanProviderSettings: async (_workspaceScope, input) => {
			const body = parseKanbanProviderSettingsSaveRequest(input);
			const response = providerService.saveProviderSettings(body);
			deps.bumpKanbanSessionContextVersion?.();
			return response;
		},
		addKanbanProvider: async (_workspaceScope, input) => {
			const body = parseKanbanAddProviderRequest(input);
			const response = await providerService.addCustomProvider(body);
			deps.bumpKanbanSessionContextVersion?.();
			return response;
		},
		updateKanbanProvider: async (_workspaceScope, input) => {
			const body = parseKanbanUpdateProviderRequest(input);
			const response = await providerService.updateCustomProvider(body);
			deps.bumpKanbanSessionContextVersion?.();
			return response;
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
				const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
				const usePiPath = effectiveAgentId === "pi";

				if (usePiPath) {
					const piLaunchConfig = resolvePiLaunchConfig({
						providerIdOverride: body.agentSettings?.providerId ?? undefined,
						modelIdOverride: body.agentSettings?.modelId ?? undefined,
						reasoningEffortOverride: body.agentSettings?.reasoningEffort ?? undefined,
					});
					const piTaskSessionService = await deps.getScopedPiTaskSessionService(workspaceScope);
					const resolvedPiTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
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
				if (!summary && isHomeAgentSessionId(body.taskId)) {
					const piLaunchConfig = resolvePiLaunchConfig({});
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
		getKanbanProviderCatalog: async (_workspaceScope) => {
			return await providerService.getProviderCatalog();
		},
		getKanbanAccountProfile: async (_workspaceScope) => {
			return await providerService.getKanbanAccountProfile();
		},
		getKanbanKanbanAccess: async (_workspaceScope) => {
			return await providerService.getKanbanKanbanAccess();
		},
		getFeaturebaseToken: async (_workspaceScope) => {
			return await providerService.getFeaturebaseToken();
		},
		getKanbanAccountBalance: async (_workspaceScope) => {
			return await providerService.getKanbanAccountBalance();
		},
		getKanbanAccountOrganizations: async (_workspaceScope) => {
			return await providerService.getKanbanAccountOrganizations();
		},
		switchKanbanAccount: async (_workspaceScope, input) => {
			const body = parseKanbanAccountSwitchRequest(input);
			return await providerService.switchKanbanAccount(body.organizationId);
		},
		getKanbanProviderModels: async (_workspaceScope, input) => {
			const body = parseKanbanProviderModelsRequest(input);
			return await providerService.getProviderModels(body.providerId);
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
			const response = await providerService.runOauthLogin({
				providerId: body.provider,
				baseUrl: body.baseUrl,
			});
			if (response.ok) {
				deps.bumpKanbanSessionContextVersion?.();
			}
			return response;
		},
		startKanbanDeviceAuth: async () => {
			return await providerService.startDeviceAuth();
		},
		completeKanbanDeviceAuth: async (_workspaceScope, input) => {
			const body = parseKanbanDeviceAuthCompleteRequest(input);
			const response = await providerService.completeDeviceAuth({
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
							return {
								ok: false,
								summary: null,
								error: "Task chat session is not running.",
							};
						}
					} else {
						const piLaunchConfig = resolvePiLaunchConfig({});
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
	};
}
