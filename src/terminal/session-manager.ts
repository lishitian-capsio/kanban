// PTY-backed runtime for non-kanban task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.

import { buildProxyEnvVars } from "../config/proxy-env";
import type {
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { getKanbanRuntimeNoProxyHosts } from "../core/runtime-endpoint";
import type { SessionMessage } from "../session/session-message";
import {
	mergeSessionMessages,
	NoopSessionMessageJournal,
	type SessionMessageJournal,
} from "../session/session-message-journal";
import type { SessionMessageListener, SessionMessageSource } from "../session/session-message-source";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { stripAnsi } from "./output-utils";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";
import { TerminalTranscriptCapture } from "./terminal-transcript-capture";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
// Shell sessions that exit within this threshold are considered immediate failures
// and trigger a retry with a fallback shell.
const SHELL_IMMEDIATE_EXIT_THRESHOLD_MS = 2_000;
// Fallback shell strategies, tried in order when the primary shell exits immediately.
// Each entry specifies binary, args, and whether to use a minimal environment.
interface ShellFallbackStrategy {
	binary: string;
	args: string[];
	minimalEnv: boolean;
	label: string;
}
const SHELL_FALLBACK_STRATEGIES: ShellFallbackStrategy[] = [
	{ binary: "bash", args: ["-i"], minimalEnv: false, label: "bash -i" },
	{ binary: "sh", args: ["-i"], minimalEnv: false, label: "sh -i" },
	{ binary: "bash", args: ["--norc", "--noprofile", "-i"], minimalEnv: false, label: "bash --norc -i" },
	{ binary: "bash", args: ["--norc", "--noprofile", "-i"], minimalEnv: true, label: "bash --norc -i (minimal env)" },
];
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	transcript: TerminalTranscriptCapture;
	// Serializes async assistant-turn captures so committed-line bookkeeping stays consistent.
	captureChain: Promise<void>;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	proxyEnabled?: boolean;
	proxyHost?: string;
	proxyPort?: string;
	proxyUsername?: string;
	proxyPassword?: string;
	noProxy?: string;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
	proxyEnabled?: boolean;
	proxyHost?: string;
	proxyPort?: string;
	proxyUsername?: string;
	proxyPassword?: string;
	noProxy?: string;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		agentSessionId: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	entry.summary = {
		...entry.summary,
		...patch,
		updatedAt: now(),
	};
	return entry.summary;
}

function isActiveState(state: RuntimeTaskSessionState): boolean {
	return state === "running" || state === "awaiting_review";
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function buildTerminalEnvironment(
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	return {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
}

// Builds a minimal environment for shell fallback when full env fails.
// Includes only essential variables to rule out env corruption.
function buildMinimalShellEnvironment(): Record<string, string | undefined> {
	const minimal: Record<string, string | undefined> = {
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		TERM_PROGRAM: "kanban",
	};
	// Copy essential env vars individually to avoid Bun Proxy issues
	const essentialKeys = ["HOME", "USER", "PATH", "SHELL", "LANG", "LC_ALL"];
	for (const key of essentialKeys) {
		const value = process.env[key];
		if (typeof value === "string" && value.length > 0) {
			minimal[key] = value;
		}
	}
	return minimal;
}

function hasCodexInteractivePrompt(text: string): boolean {
	const stripped = stripAnsi(text);
	return /(?:^|[\n\r])\s*›\s*/u.test(stripped);
}

function hasCodexStartupUiRendered(text: string): boolean {
	const stripped = stripAnsi(text).toLowerCase();
	return stripped.includes("openai codex (v");
}

export interface TerminalSessionManagerOptions {
	/** Durable transcript store; defaults to an in-memory-only no-op. */
	messageJournal?: SessionMessageJournal;
}

export class TerminalSessionManager implements TerminalSessionService, SessionMessageSource {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly messageListeners = new Set<SessionMessageListener>();
	private readonly messageJournal: SessionMessageJournal;

	constructor(options: TerminalSessionManagerOptions = {}) {
		this.messageJournal = options.messageJournal ?? new NoopSessionMessageJournal();
	}

	private trySendDeferredCodexStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active || entry.summary.agentId !== "codex") {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			active.workspaceTrustBuffer !== null && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer);
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		active.session.write(deferredInput);
		return true;
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onMessage(listener: SessionMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	listMessages(taskId: string): SessionMessage[] {
		return this.entries.get(taskId)?.transcript.listMessages() ?? [];
	}

	async loadTaskSessionMessages(taskId: string): Promise<SessionMessage[]> {
		const persisted = await this.messageJournal.loadMessages(taskId);
		return mergeSessionMessages(persisted, this.listMessages(taskId));
	}

	private emitMessage(taskId: string, message: SessionMessage): void {
		for (const listener of this.messageListeners) {
			listener(taskId, message);
		}
		this.messageJournal.recordMessage(taskId, message);
	}

	// Folds the terminal scrollback that has scrolled above the live viewport into
	// a single `assistant` message at a turn boundary. Serialized per entry via
	// captureChain so the committed-line cursor advances consistently.
	private captureAssistantTurn(entry: SessionEntry): void {
		const mirror = entry.terminalStateMirror;
		if (!mirror) {
			return;
		}
		const taskId = entry.summary.taskId;
		entry.captureChain = entry.captureChain
			.catch(() => undefined)
			.then(async () => {
				const committedLines = await mirror.getCommittedLines();
				const message = entry.transcript.captureCommittedLines(committedLines);
				if (message) {
					this.emitMessage(taskId, message);
				}
			})
			.catch(() => {
				// Best effort: transcript capture must never disrupt the session lifecycle.
			});
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			this.entries.set(taskId, {
				summary: cloneSummary(summary),
				active: null,
				terminalStateMirror: null,
				transcript: new TerminalTranscriptCapture(taskId),
				captureChain: Promise.resolve(),
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
			});
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		return await entry.terminalStateMirror.getSnapshot();
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		// Carry forward any session id pinned on a previous launch (in-memory or hydrated from
		// disk after a restart) so the adapter can re-attach to that exact agent conversation.
		const recordedAgentSessionId = entry.summary.agentSessionId ?? null;
		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			agentSessionId: recordedAgentSessionId,
			env: request.env,
			workspaceId: request.workspaceId,
		});

		const env = buildTerminalEnvironment(
			request.env,
			launch.env,
			buildProxyEnvVars(
				request.proxyEnabled ?? false,
				request.proxyHost ?? "",
				request.proxyPort ?? "",
				request.proxyUsername ?? "",
				request.proxyPassword ?? "",
				request.noProxy ?? "",
				getKanbanRuntimeNoProxyHosts(),
			),
		);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					const needsDecodedOutput =
						entry.active.workspaceTrustBuffer !== null ||
						(entry.active.detectOutputTransition !== null &&
							(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true));
					const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += data;
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
						if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
							const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
							if (hasClaudePrompt || hasCodexPrompt) {
								entry.active.autoConfirmedWorkspaceTrust = true;
								const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
								entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
									const activeEntry = this.entries.get(request.taskId)?.active;
									if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
										return;
									}
									activeEntry.session.write("\r");
									// Trust text can remain in the rolling buffer after we auto-confirm.
									// Clear it so later startup/prompt checks do not match stale trust output.
									if (activeEntry.workspaceTrustBuffer !== null) {
										activeEntry.workspaceTrustBuffer = "";
									}
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					// Codex plan-mode startup input is deferred until we know the TUI rendered.
					// Trigger on either the interactive prompt marker or the startup header text.
					if (
						entry.summary.agentId === "codex" &&
						entry.active.deferredStartupInput !== null &&
						data.length > 0 &&
						(hasCodexInteractivePrompt(data) ||
							hasCodexStartupUiRendered(data) ||
							(entry.active.workspaceTrustBuffer !== null &&
								(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
									hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))))
					) {
						this.trySendDeferredCodexStartupInput(request.taskId);
					}

					const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
					if (adapterEvent) {
						const requiresEnterForCodex =
							adapterEvent.type === "agent.prompt-ready" &&
							entry.summary.agentId === "codex" &&
							!entry.active.awaitingCodexPromptAfterEnter;
						if (!requiresEnterForCodex) {
							const summary = this.applySessionEvent(entry, adapterEvent);
							if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
								entry.active.awaitingCodexPromptAfterEnter = false;
							}
							for (const taskListener of entry.listeners.values()) {
								taskListener.onState?.(cloneSummary(summary));
							}
							this.emitSummary(summary);
						}
					}

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		// New PTY + mirror means scrollback restarts; rebase the transcript cursor
		// and record the kickoff prompt as the opening user message.
		entry.transcript.resetTurnBaseline();
		const promptMessage = entry.transcript.recordUserPrompt(request.prompt);
		if (promptMessage) {
			this.emitMessage(request.taskId, promptMessage);
		}

		const startedAt = now();
		updateSummary(entry, {
			state: request.resumeFromTrash ? "awaiting_review" : "running",
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			agentSessionId: launch.agentSessionId ?? recordedAgentSessionId,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		return this.spawnShellProcess(request, 0);
	}

	private async spawnShellProcess(
		request: StartShellSessionRequest,
		fallbackIndex: number,
	): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && entry.summary.state === "running") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment(
			request.env,
			buildProxyEnvVars(
				request.proxyEnabled ?? false,
				request.proxyHost ?? "",
				request.proxyPort ?? "",
				request.proxyUsername ?? "",
				request.proxyPassword ?? "",
				request.noProxy ?? "",
				getKanbanRuntimeNoProxyHosts(),
			),
		);
		const sessionStartedAt = now();

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);

					const sessionDurationMs = now() - sessionStartedAt;
					const isImmediateExit =
						event.exitCode === 0 &&
						sessionDurationMs < SHELL_IMMEDIATE_EXIT_THRESHOLD_MS &&
						!currentActive.session.wasInterrupted();

					// Check if we should try a fallback shell strategy
					if (isImmediateExit && fallbackIndex < SHELL_FALLBACK_STRATEGIES.length) {
						const strategy = SHELL_FALLBACK_STRATEGIES[fallbackIndex];
						// Skip if strategy uses the same binary AND args as the current request
						if (
							strategy.binary === request.binary &&
							JSON.stringify(strategy.args) === JSON.stringify(request.args ?? [])
						) {
							void this.spawnShellProcess(request, fallbackIndex + 1);
							return;
						}
						// Notify listeners about the retry
						const retryMessage = Buffer.from(
							`\r\n[kanban] Shell exited immediately. Trying fallback: ${strategy.label}\r\n`,
							"utf8",
						);
						for (const taskListener of currentEntry.listeners.values()) {
							taskListener.onOutput?.(retryMessage);
						}
						// Build fallback request, optionally with minimal env
						const fallbackRequest: StartShellSessionRequest = {
							...request,
							binary: strategy.binary,
							args: strategy.args,
						};
						if (strategy.minimalEnv) {
							fallbackRequest.env = buildMinimalShellEnvironment();
						}
						void this.spawnShellProcess(fallbackRequest, fallbackIndex + 1);
						return;
					}

					// All fallbacks exhausted - output diagnostic info
					if (isImmediateExit) {
						const runtimeName = typeof Bun !== "undefined" ? "bun" : "node";
						const envKeyCount = Object.keys(env).length;
						const diagMessage = Buffer.from(
							`\r\n[kanban] All shell fallbacks failed.\r\n` +
								`  Runtime: ${runtimeName} ${typeof process !== "undefined" ? process.version : "unknown"}\r\n` +
								`  CWD: ${request.cwd}\r\n` +
								`  Shell: ${request.binary} ${request.args?.join(" ") ?? ""}\r\n` +
								`  Env keys: ${envKeyCount}\r\n` +
								`  Exit code: ${event.exitCode}\r\n` +
								`  Duration: ${sessionDurationMs}ms\r\n`,
							"utf8",
						);
						for (const taskListener of currentEntry.listeners.values()) {
							taskListener.onOutput?.(diagMessage);
						}
					}

					const summary = updateSummary(currentEntry, {
						state: currentActive.session.wasInterrupted() ? "interrupted" : "idle",
						reviewReason: currentActive.session.wasInterrupted() ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				state: "failed",
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		updateSummary(entry, {
			state: "running",
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: sessionStartedAt,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isActiveState(entry.summary.state)) {
			return cloneSummary(entry.summary);
		}

		// Preserve agentId so the server can route to the correct agent type
		// (kanban vs terminal PTY) when a task is restored from trash.
		const summary = updateSummary(entry, {
			state: "idle",
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		if (
			entry.summary.agentId === "codex" &&
			entry.summary.state === "awaiting_review" &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		// Fold follow-up prompts typed into an agent session into the transcript.
		// Shell sessions (no agentId) carry no conversational transcript.
		if (entry.summary.agentId !== null) {
			for (const message of entry.transcript.recordInput(data.toString("utf8"))) {
				this.emitMessage(taskId, message);
			}
		}
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(taskId: string, reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_review" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		// Persist any debounced transcript tail before the workspace tears down.
		void this.messageJournal.flush();
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		if (entry.active && transition.changed && transition.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		// Entering review is the CLI agent's turn boundary: fold the freshly
		// committed scrollback into an assistant message. Guarded on the mirror so
		// hydrated/inactive entries (and unit-test fakes) are skipped.
		if (transition.changed && transition.patch.state === "awaiting_review" && entry.terminalStateMirror) {
			this.captureAssistantTurn(entry);
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			terminalStateMirror: null,
			transcript: new TerminalTranscriptCapture(taskId),
			captureChain: Promise.resolve(),
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
