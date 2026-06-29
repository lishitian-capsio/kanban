// PTY-backed runtime for non-kanban task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.

import type { CommittedProviderLayer } from "../agent-sdk/kanban/agent-provider-resolver";
import type {
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUsage,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { createLogger } from "../logging";
import type { SessionMessage } from "../session/session-message";
import { NoopSessionMessageJournal, type SessionMessageJournal } from "../session/session-message-journal";
import { SessionMessageMergeCache } from "../session/session-message-merge-cache";
import type { SessionMessageListener, SessionMessageSource } from "../session/session-message-source";
import { type AgentProviderEnv, buildAgentProviderEnv } from "../unified-proxy/env-injector";
import { buildBridgeProxyEnvVars } from "../unified-proxy/network-bridge";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	type PreparedAgentLaunch,
	prepareAgentLaunch,
} from "./agent-session-adapters";
import { readClaudeSessionUsage } from "./claude-session-usage";
import { readCodexSessionUsage } from "./codex-session-usage";
import type { SessionUsageReadCache } from "./session-usage-cache";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import { buildPathWithBinaryDir } from "./command-discovery";
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

const log = createLogger("terminal-session-manager");

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
	// Effective on-disk sessions dir for the token-usage reader (Codex rollouts);
	// set from the prepared launch. Null for agents whose usage file is derivable
	// from the summary alone (Claude) or that emit no transcript.
	sessionUsageDir: string | null;
	// Memo of the last token-usage read (resolved transcript path + mtime/size +
	// parsed usage). Lets a turn-boundary refresh skip the rollout-locator walk and
	// the whole-file re-parse when nothing changed (findings T1/T2). Reset to null on
	// each (re)launch so a resumed conversation re-resolves its transcript.
	usageCache: SessionUsageReadCache | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	/**
	 * Provider selected for this session (provider name = providerId). Picks which
	 * of the agent's registered providers to inject as env. Falls back to the
	 * agent's default provider when unset.
	 */
	providerId?: string;
	/**
	 * The workspace's selected committed provider for this agent (secret-free).
	 * Folded into provider selection below `providerId` so a workspace can pin a
	 * provider/model for an agent without a per-session override.
	 */
	committedProvider?: CommittedProviderLayer | null;
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
		providerId: null,
		modelId: null,
		usage: null,
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

/**
 * Per-output-chunk `lastOutputAt` bump. Mutates in place rather than spreading a
 * fresh ~16-field summary object on every chunk (finding T5) — this fires on the
 * hottest path under token streaming and does not broadcast (no `emitSummary`), so
 * there is no observer that needs a new object identity. Listeners always receive a
 * `cloneSummary` copy at the discrete emit sites, never this raw reference.
 */
function touchLastOutput(entry: SessionEntry): void {
	const timestamp = now();
	entry.summary.lastOutputAt = timestamp;
	entry.summary.updatedAt = timestamp;
}

/**
 * Release the workspace-trust scratch buffer once the trust prompt is handled, so
 * the per-chunk decode + concat gate (`needsDecodedOutput`) closes for the rest of
 * the session (finding T4): for Claude that stops the decode entirely; for Codex it
 * stops it outside the `awaiting_review` transition-inspection window. Set to `null`
 * (gate closed) when nothing else needs it. While a Codex deferred startup input is
 * still pending (plan-mode launch), keep an empty buffer so the startup-UI fallback
 * can still match the accumulated output — nulling too early would break plan-mode
 * startup detection.
 */
function releaseWorkspaceTrustBuffer(active: ActiveProcessState): void {
	if (active.workspaceTrustBuffer === null) {
		return;
	}
	active.workspaceTrustBuffer = active.deferredStartupInput !== null ? "" : null;
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
	private readonly mergeCache = new SessionMessageMergeCache();

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
		// Codex startup is complete: trust is auto-confirmed and the plan-mode input is
		// in flight, so the trust buffer's last consumer (the startup-UI fallback) is
		// done. Release it to close the per-chunk decode gate during streaming (T4).
		releaseWorkspaceTrustBuffer(active);
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
		return this.mergeCache.resolve(taskId, this.messageJournal.getGeneration(taskId), this.listMessages(taskId), () =>
			this.messageJournal.loadMessages(taskId),
		);
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
				sessionUsageDir: null,
				usageCache: null,
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

		// Build provider-specific env vars (custom baseUrl/apiKey for non-official providers).
		// The session's selected providerId picks which registered provider to inject.
		// Done before prepareAgentLaunch so the resolved model can reach adapters that
		// apply it via native config rather than env (e.g. Kiro's agent JSON).
		//
		// OpenCode is the exception: it consumes its provider through a native
		// OPENCODE_CONFIG projection in the adapter (provider/model/small_model +
		// provider.<id>), not generic OPENAI_*/ANTHROPIC_* env. Injecting those shared
		// env keys would also clobber the user's *other* OpenCode providers, so we skip
		// the env path for it entirely.
		const agentProviderEnv: AgentProviderEnv =
			request.agentId === "opencode"
				? { env: {}, usesCustomProvider: false }
				: await buildAgentProviderEnv(request.agentId, request.providerId, request.committedProvider);

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
			providerId: request.providerId,
			committedProvider: request.committedProvider,
			model: agentProviderEnv.resolvedModelId,
		});

		// When the agent is launched via an explicit absolute executable path
		// (the per-agent override), prepend that binary's own directory to PATH so a
		// `#!/usr/bin/env node`-style wrapper can still find its colocated interpreter
		// even when the runtime's PATH (e.g. a systemd daemon's) omits it. No-op for
		// a bare binary name discovered on PATH.
		const launchPath = buildPathWithBinaryDir(request.binary, process.env.PATH);
		const binaryDirPathEnv = launchPath && launchPath !== process.env.PATH ? { PATH: launchPath } : undefined;
		const env = buildTerminalEnvironment(
			request.env,
			launch.env,
			agentProviderEnv.env,
			buildBridgeProxyEnvVars(),
			binaryDirPathEnv,
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
									// Release it so later startup/prompt checks do not match stale trust
									// output, and so the per-chunk decode gate can close (finding T4).
									releaseWorkspaceTrustBuffer(activeEntry);
									activeEntry.workspaceTrustConfirmTimer = null;
								}, trustConfirmDelayMs);
							}
						}
					}
					touchLastOutput(entry);

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

					// Skip the fanout entirely when no viewer is attached (the common
					// background-session case): the live stream has no subscribers, so
					// iterating is pure overhead per chunk.
					if (entry.listeners.size > 0) {
						for (const taskListener of entry.listeners.values()) {
							taskListener.onOutput?.(filteredChunk);
						}
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
			providerId: request.providerId ?? null,
			modelId: agentProviderEnv.resolvedModelId ?? null,
		});
		this.emitSummary(entry.summary);

		// Some agents (Codex) allocate their session id at startup rather than accepting a
		// pinned one, so the adapter exposes a post-launch capture hook. Run it in the
		// background and persist the result so the conversation can be resumed after a
		// restart. Fire-and-forget: it must not delay the session-start response.
		if (launch.captureAgentSessionId) {
			void this.captureAndApplyAgentSessionId(entry, session, launch.captureAgentSessionId, startedAt);
		}

		// Remember where this agent writes its transcript so the token-usage reader
		// can re-read it at turn boundaries (Codex rollouts; tracks any projected
		// custom-provider CODEX_HOME). Claude derives its file from the summary alone.
		entry.sessionUsageDir = launch.sessionUsageDir ?? null;
		// Drop any prior usage memo: a (re)launch may resume onto a different
		// transcript/rollout, so the resolved path + parse must be re-derived.
		entry.usageCache = null;

		// Self-heal the token-usage chip on (re)launch: a resumed session already has
		// a transcript on disk, so reading it now surfaces the prior cumulative usage
		// immediately — before the first new turn boundary. No-op for a fresh task
		// (file absent) or an agent without a readable transcript. Fire-and-forget.
		void this.captureSessionUsage(request.taskId);

		return cloneSummary(entry.summary);
	}

	/**
	 * Resolve an agent-native session id via the adapter's post-launch capture hook and
	 * persist it onto the live summary (which the existing `listSummaries()` persistence
	 * path then writes to disk, so it survives a restart). Guarded by session identity:
	 * if the live session was replaced (restart/stop) between launch and capture, the
	 * captured id is dropped to avoid mis-resuming a different conversation.
	 */
	private async captureAndApplyAgentSessionId(
		entry: SessionEntry,
		session: PtySession,
		capture: NonNullable<PreparedAgentLaunch["captureAgentSessionId"]>,
		startedAtMs: number,
	): Promise<void> {
		let capturedId: string | null;
		try {
			capturedId = await capture({ startedAtMs });
		} catch (error) {
			log.warn("Failed to capture agent session id", { taskId: entry.summary.taskId, error });
			return;
		}
		if (!capturedId) {
			return;
		}
		const current = this.entries.get(entry.summary.taskId);
		if (!current || current.active?.session !== session) {
			return;
		}
		if (current.summary.agentSessionId === capturedId) {
			return;
		}
		const summary = updateSummary(current, { agentSessionId: capturedId });
		log.debug("Captured agent session id after launch", {
			taskId: current.summary.taskId,
			agentSessionId: capturedId,
		});
		this.emitSummary(summary);
	}

	/**
	 * Refresh a CLI agent's cumulative token usage from its on-disk session
	 * transcript and fold the result onto the live summary. CLI agents emit no
	 * token telemetry to Kanban, but Claude records per-message `usage` to a local
	 * JSONL keyed by the session id Kanban already pins, and Codex records a
	 * cumulative `total_token_usage` in its rollout file — so re-reading those at a
	 * turn boundary (and on relaunch) is the equivalent of pi's per-run accumulate.
	 * The on-disk file holds the *full* session, so this SETs the total
	 * (idempotent) rather than incrementing. Persisted + broadcast through the same
	 * `updateSummary` → `listSummaries()` → `sessions.json` / websocket path as pi.
	 * Best-effort: any read failure leaves the prior usage untouched and never
	 * disrupts the session lifecycle.
	 */
	private async captureSessionUsage(taskId: string): Promise<void> {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		const agentId = entry.summary.agentId;
		const cwd = entry.summary.workspacePath;
		if (!cwd) {
			return;
		}
		const sessionId = entry.summary.agentSessionId;
		const priorCache = entry.usageCache;
		let usage: RuntimeTaskSessionUsage | null;
		let nextCache: SessionUsageReadCache | null;
		if (agentId === "claude") {
			// Claude's transcript path is derivable from the pinned session id + cwd.
			if (!sessionId) {
				return;
			}
			({ usage, cache: nextCache } = await readClaudeSessionUsage({ cwd, sessionId }, priorCache));
		} else if (agentId === "codex") {
			// Codex's rollout is located by cwd (id-independent), so usage surfaces
			// even before the post-launch session-id capture lands.
			if (!entry.sessionUsageDir) {
				return;
			}
			({ usage, cache: nextCache } = await readCodexSessionUsage(
				{ sessionsDir: entry.sessionUsageDir, cwd },
				priorCache,
			));
		} else {
			return;
		}
		// Re-resolve after the await: the agent (and, for Claude, the session id the
		// file is keyed by) must still match what we read for, so a relaunch onto a
		// different conversation can't be stamped with the old file's usage. Skip
		// no-op and stale (smaller) reads — usage only grows, so an out-of-order
		// concurrent read must not regress the displayed total.
		const current = this.entries.get(taskId);
		if (!current || current.summary.agentId !== agentId) {
			return;
		}
		if (agentId === "claude" && current.summary.agentSessionId !== sessionId) {
			return;
		}
		// Persist the memo (resolved transcript path + signature + parse) so the next
		// refresh can skip the locator walk and the re-parse — but only when no
		// concurrent (re)launch or refresh replaced it meanwhile. Identity-comparing
		// against the snapshot we started from means a relaunch's reset-to-null is never
		// clobbered by this in-flight read's stale memo.
		if (current.usageCache === priorCache) {
			current.usageCache = nextCache;
		}
		if (!usage) {
			return;
		}
		const prev = current.summary.usage ?? null;
		if (
			prev &&
			prev.inputTokens === usage.inputTokens &&
			prev.outputTokens === usage.outputTokens &&
			prev.totalTokens === usage.totalTokens
		) {
			return;
		}
		if (prev && usage.totalTokens < prev.totalTokens) {
			return;
		}
		const summary = updateSummary(current, { usage });
		if (current.active) {
			for (const listener of current.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
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
		const env = buildTerminalEnvironment(request.env, buildBridgeProxyEnvVars());
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
					touchLastOutput(entry);

					if (entry.listeners.size > 0) {
						for (const taskListener of entry.listeners.values()) {
							taskListener.onOutput?.(filteredChunk);
						}
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

	/**
	 * Permanently close a single session: stop any active process, drop its
	 * in-memory entry (mirror + listeners), and delete its persisted transcript.
	 * Used when a home chat thread is closed.
	 */
	async closeTaskSession(taskId: string): Promise<void> {
		const entry = this.entries.get(taskId);
		this.mergeCache.invalidate(taskId);
		if (!entry) {
			await this.messageJournal.clear(taskId);
			return;
		}
		this.stopTaskSession(taskId);
		entry.terminalStateMirror?.dispose();
		entry.listeners.clear();
		this.entries.delete(taskId);
		await this.messageJournal.clear(taskId);
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
			releaseWorkspaceTrustBuffer(entry.active);
		}
		if (entry.active && transition.changed && transition.patch.state === "awaiting_review") {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		// Entering review is the CLI agent's turn boundary: fold the freshly
		// committed scrollback into an assistant message. Guarded on the mirror so
		// hydrated/inactive entries (and unit-test fakes) are skipped.
		if (transition.changed && transition.patch.state === "awaiting_review" && entry.terminalStateMirror) {
			this.captureAssistantTurn(entry);
			// Turn boundary is also when the agent has flushed its latest messages
			// (with token usage) to its session transcript. Re-read it to refresh the
			// cumulative usage chip. Fire-and-forget — never blocks the transition.
			void this.captureSessionUsage(entry.summary.taskId);
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
			sessionUsageDir: null,
			usageCache: null,
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
