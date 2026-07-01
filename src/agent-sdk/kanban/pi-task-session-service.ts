// Task-oriented facade for pi agent sessions.
// runtime-api.ts uses this service to start sessions, send messages,
// and subscribe to summaries and chat events.
import type {
	RuntimeReasoningEffort,
	RuntimeSlashCommand,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../../core/api-contract";
import { createSessionMessage, now, type SessionMessage } from "../../session/session-message";
import { clearActiveTurnState } from "../../session/session-message-buffer";
import { NoopSessionMessageJournal, type SessionMessageJournal } from "../../session/session-message-journal";
import { SessionMessageMergeCache } from "../../session/session-message-merge-cache";
import type { SessionMessageSource } from "../../session/session-message-source";
import type { AgentEvent } from "../types";
import {
	type CreatePiAgentRuntimeOptions,
	createInMemoryPiAgentRuntime,
	type PiAgentRuntime,
	type PiSubagentEventInfo,
	type StartPiSessionRequest,
} from "./pi-agent-runtime";
import { accumulateUsage, applyPiAgentEvent } from "./pi-event-adapter";
import { PI_DEFAULT_MODEL_ID, PI_DEFAULT_PROVIDER_ID } from "./pi-provider-config";
import { applySubagentLifecycle } from "./pi-subagent-adapter";
import {
	cloneSummary,
	createDefaultSummary,
	createKanbanTaskSessionEntry,
	type KanbanTaskSessionEntry,
	updateSummary,
} from "./session-state";

export type { SessionMessage } from "../../session/session-message";

export interface StartPiTaskSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	startInPlanMode?: boolean;
	taskTitle?: string;
	images?: RuntimeTaskImage[];
	resumeFromTrash?: boolean;
	resumeFromPersistence?: boolean;
	providerId?: string | null;
	modelId?: string | null;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
	systemPrompt?: string | null;
}

export interface PiTaskSessionService extends SessionMessageSource {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	startTaskSession(request: StartPiTaskSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	/**
	 * Whether a live agent is currently running for this task. The live agent
	 * lives in the agent runtime, which can diverge from the message-store entry
	 * (e.g. a start that failed before populating the runtime, or a disposed
	 * session). Callers use this to decide whether a message can be delivered to
	 * an existing session or the session must be (re)started first.
	 */
	hasActiveAgentSession(taskId: string): boolean;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	/** Permanently close a session: stop, drop in-memory state, delete transcript. */
	closeTaskSession(taskId: string): Promise<void>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listSlashCommands(workspacePath: string): Promise<RuntimeSlashCommand[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): Promise<void>;
}

export interface CreatePiTaskSessionServiceOptions {
	createAgentRuntime?: (options: CreatePiAgentRuntimeOptions) => PiAgentRuntime;
	/** Durable transcript store; defaults to an in-memory-only no-op. */
	messageJournal?: SessionMessageJournal;
}

/**
 * In-memory message store for pi task sessions.
 * Lightweight replacement for KanbanMessageRepository.
 */
class PiMessageStore {
	private entries = new Map<string, KanbanTaskSessionEntry>();
	// Subagent transcripts live in a SEPARATE map, NOT in `entries`, so they never leak into
	// `listSummaries()` (→ sessions.json / phantom board sessions). Their status/tokens are
	// projected onto the PARENT summary's `subagents[]` instead. Keyed by composite session id.
	private subagentBuffers = new Map<string, KanbanTaskSessionEntry>();
	private summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private messageListeners = new Set<(taskId: string, message: SessionMessage) => void>();
	private readonly mergeCache = new SessionMessageMergeCache();

	constructor(private readonly journal: SessionMessageJournal) {}

	getTaskEntry(taskId: string): KanbanTaskSessionEntry | undefined {
		return this.entries.get(taskId);
	}

	setTaskEntry(taskId: string, entry: KanbanTaskSessionEntry): void {
		this.entries.set(taskId, entry);
	}

	/** Get (or lazily create) the transcript buffer for a subagent's composite session id. */
	getOrCreateSubagentEntry(compositeId: string): KanbanTaskSessionEntry {
		let entry = this.subagentBuffers.get(compositeId);
		if (!entry) {
			// The summary here is a throwaway — subagents have no top-level summary; it exists only
			// because the shared event adapter mutates entry.summary (we swallow those emits).
			entry = createKanbanTaskSessionEntry(createDefaultSummary(compositeId));
			this.subagentBuffers.set(compositeId, entry);
		}
		return entry;
	}

	dropSubagentBuffer(compositeId: string): void {
		this.subagentBuffers.delete(compositeId);
		this.mergeCache.invalidate(compositeId);
	}

	/** Drop a subagent transcript from memory AND disk (its own composite-id journal dir). */
	async clearSubagentTranscript(compositeId: string): Promise<void> {
		this.dropSubagentBuffer(compositeId);
		await this.journal.clear(compositeId);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.entries.get(taskId)?.summary ?? null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return [...this.entries.values()].map((e) => cloneSummary(e.summary));
	}

	listMessages(taskId: string): SessionMessage[] {
		const entry = this.entries.get(taskId) ?? this.subagentBuffers.get(taskId);
		return entry?.messages.slice() ?? [];
	}

	emitSummary(summary: RuntimeTaskSessionSummary): void {
		for (const listener of this.summaryListeners) {
			listener(summary);
		}
	}

	emitMessage(taskId: string, message: SessionMessage): void {
		for (const listener of this.messageListeners) {
			listener(taskId, message);
		}
		this.journal.recordMessage(taskId, message);
	}

	loadPersistedMessages(taskId: string): Promise<SessionMessage[]> {
		return this.journal.loadMessages(taskId);
	}

	loadMergedMessages(taskId: string): Promise<SessionMessage[]> {
		return this.mergeCache.resolve(taskId, this.journal.getGeneration(taskId), this.listMessages(taskId), () =>
			this.journal.loadMessages(taskId),
		);
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => this.summaryListeners.delete(listener);
	}

	onMessage(listener: (taskId: string, message: SessionMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	clearTaskMessages(taskId: string): void {
		const entry = this.entries.get(taskId);
		if (entry) {
			entry.messages = [];
			clearActiveTurnState(entry);
		}
		this.mergeCache.invalidate(taskId);
		// clear() synchronously enqueues the file removal, so a subsequent
		// loadMessages chains after it — fire-and-forget is ordering-safe.
		void this.journal.clear(taskId);
	}

	async deleteTaskEntry(taskId: string): Promise<void> {
		this.entries.delete(taskId);
		this.mergeCache.invalidate(taskId);
		await this.journal.clear(taskId);
	}

	async dispose(): Promise<void> {
		this.summaryListeners.clear();
		this.messageListeners.clear();
		this.entries.clear();
		this.subagentBuffers.clear();
		await this.journal.dispose();
	}
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0) return message;
	}
	return "Unknown error";
}

function buildPiStartPrompt(prompt: string, startInPlanMode?: boolean): string {
	if (!startInPlanMode) return prompt;
	const trimmed = prompt.trim();
	return [
		"First, inspect the codebase and produce a clear implementation plan only.",
		"Do not modify files, do not use write tools, and do not implement anything yet.",
		"After you present the plan, ask for approval before making changes.",
		trimmed ? `\n\nTask:\n${trimmed}` : " Ask the user what they want planned if the task is unclear.",
	].join(" ");
}

export class InMemoryPiTaskSessionService implements PiTaskSessionService {
	private readonly pendingTurnCancelTaskIds = new Set<string>();
	// Subagents have no per-turn cancel of their own (they are aborted with the parent), so their
	// event stream always uses an empty cancel set — the adapter's "turn canceled" path never fires.
	private readonly noSubagentTurnCancel = new Set<string>();
	private readonly agentRuntime: PiAgentRuntime;
	private readonly messageStore: PiMessageStore;

	constructor(options: CreatePiTaskSessionServiceOptions = {}) {
		this.messageStore = new PiMessageStore(options.messageJournal ?? new NoopSessionMessageJournal());
		const createAgentRuntime = options.createAgentRuntime ?? createInMemoryPiAgentRuntime;
		this.agentRuntime = createAgentRuntime({
			onTaskEvent: (taskId: string, event: AgentEvent) => {
				this.handleTaskEvent(taskId, event);
			},
			onSubagentEvent: (info: PiSubagentEventInfo, event: AgentEvent) => {
				this.handleSubagentEvent(info, event);
			},
		});
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.messageStore.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: SessionMessage) => void): () => void {
		return this.messageStore.onMessage(listener);
	}

	async startTaskSession(request: StartPiTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const existing = this.messageStore.getTaskEntry(request.taskId);
		if (
			!request.resumeFromTrash &&
			!request.resumeFromPersistence &&
			existing &&
			(existing.summary.state === "running" || existing.summary.state === "awaiting_review")
		) {
			return cloneSummary(existing.summary);
		}

		const providerId = request.providerId?.trim().toLowerCase() || PI_DEFAULT_PROVIDER_ID;
		const modelId = request.modelId?.trim() || PI_DEFAULT_MODEL_ID;
		const resolvedMode: RuntimeTaskSessionMode = request.startInPlanMode ? "act" : (request.mode ?? "act");
		const normalizedPrompt = request.prompt.trim();
		const hasRequestImages = Boolean(request.images && request.images.length > 0);
		const initialState = request.resumeFromTrash
			? "awaiting_review"
			: normalizedPrompt.length > 0 || hasRequestImages
				? "running"
				: "idle";
		const initialReviewReason = request.resumeFromTrash ? "attention" : null;

		const entry = createKanbanTaskSessionEntry({
			...createDefaultSummary(request.taskId),
			state: initialState as any,
			mode: resolvedMode,
			agentId: "pi",
			workspacePath: request.cwd,
			startedAt: now(),
			lastOutputAt: now(),
			reviewReason: initialReviewReason,
			providerId,
			modelId,
		});
		this.messageStore.setTaskEntry(request.taskId, entry);
		this.pendingTurnCancelTaskIds.delete(request.taskId);

		// Emit user message
		if (!request.resumeFromTrash && (normalizedPrompt.length > 0 || hasRequestImages)) {
			const message = createSessionMessage(request.taskId, "user", normalizedPrompt, request.images);
			entry.messages.push(message);
			this.messageStore.emitMessage(request.taskId, message);
			const runningSummary = updateSummary(entry, {
				state: "running",
				reviewReason: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "pi-agent",
				},
			});
			this.messageStore.emitSummary(runningSummary);
		}
		this.messageStore.emitSummary(entry.summary);

		// Start session asynchronously
		void (async () => {
			try {
				const startRequest: StartPiSessionRequest = {
					taskId: request.taskId,
					cwd: request.cwd,
					prompt: buildPiStartPrompt(request.prompt, request.startInPlanMode),
					taskTitle: request.taskTitle,
					images: request.images,
					providerId,
					modelId,
					mode: resolvedMode,
					apiKey: request.apiKey,
					baseUrl: request.baseUrl,
					reasoningEffort: request.reasoningEffort,
					systemPrompt: request.systemPrompt,
					startInPlanMode: request.startInPlanMode,
				};
				await this.agentRuntime.startSession(startRequest);
			} catch (error) {
				this.emitTaskFailure(request.taskId, entry, "start", error);
			}
		})();

		return cloneSummary(entry.summary);
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.agentRuntime.stopSession(taskId).catch(() => null);
		if (entry.summary.state === "idle") {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.messageStore.emitSummary(summary);
		return summary;
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.agentRuntime.abortSession(taskId).catch(() => null);
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.messageStore.emitSummary(summary);
		return summary;
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		if (entry.summary.state !== "running") return null;
		this.pendingTurnCancelTaskIds.add(taskId);
		await this.agentRuntime.abortSession(taskId).catch(() => null);
		clearActiveTurnState(entry);
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			exitCode: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: "pi-agent",
			},
		});
		this.messageStore.emitSummary(summary);
		return summary;
	}

	async sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		if (
			entry.summary.state !== "running" &&
			entry.summary.state !== "awaiting_review" &&
			entry.summary.state !== "idle" &&
			entry.summary.state !== "failed"
		) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		const normalized = text.trim();
		const hasImages = Boolean(images && images.length > 0);
		if (normalized.length === 0 && !hasImages) return null;

		const effectiveMode: RuntimeTaskSessionMode = mode ?? entry.summary.mode ?? "act";
		const message = createSessionMessage(taskId, "user", normalized, images);
		entry.messages.push(message);
		this.messageStore.emitMessage(taskId, message);
		clearActiveTurnState(entry);

		const waitingSummary = updateSummary(entry, {
			state: "running",
			mode: effectiveMode,
			reviewReason: null,
			warningMessage: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Agent active",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_start",
				notificationType: null,
				source: "pi-agent",
			},
		});
		this.messageStore.emitSummary(waitingSummary);

		// Send input asynchronously
		void this.agentRuntime.sendInput(taskId, normalized, effectiveMode, images).catch((error: unknown) => {
			this.emitTaskFailure(taskId, entry, "send", error);
		});

		return cloneSummary(entry.summary);
	}

	hasActiveAgentSession(taskId: string): boolean {
		return this.agentRuntime.getSession(taskId) !== null;
	}

	async reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.agentRuntime.stopSession(taskId).catch(() => null);
		clearActiveTurnState(entry);
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			lastOutputAt: now(),
		});
		this.messageStore.emitSummary(summary);
		return cloneSummary(summary);
	}

	async clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const existingEntry = this.messageStore.getTaskEntry(taskId);
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.agentRuntime.clearSessions(taskId).catch(() => undefined);
		await this.clearSubagentTranscripts(existingEntry);
		this.messageStore.clearTaskMessages(taskId);
		if (!existingEntry) return null;

		const clearedEntry = createKanbanTaskSessionEntry({
			...createDefaultSummary(taskId),
			mode: existingEntry.summary.mode,
			workspacePath: existingEntry.summary.workspacePath,
		});
		this.messageStore.setTaskEntry(taskId, clearedEntry);
		this.messageStore.emitSummary(clearedEntry.summary);
		return cloneSummary(clearedEntry.summary);
	}

	async closeTaskSession(taskId: string): Promise<void> {
		this.pendingTurnCancelTaskIds.delete(taskId);
		const existingEntry = this.messageStore.getTaskEntry(taskId);
		await this.stopTaskSession(taskId).catch(() => null);
		await this.agentRuntime.clearSessions(taskId).catch(() => undefined);
		await this.clearSubagentTranscripts(existingEntry);
		await this.messageStore.deleteTaskEntry(taskId);
	}

	/** Drop every subagent transcript (memory + disk) belonging to a parent session. */
	private async clearSubagentTranscripts(parentEntry: KanbanTaskSessionEntry | undefined): Promise<void> {
		const subagents = parentEntry?.summary.subagents;
		if (!subagents || subagents.length === 0) return;
		await Promise.all(
			subagents.map((subagent) => this.messageStore.clearSubagentTranscript(subagent.sessionId).catch(() => undefined)),
		);
	}

	async rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (entry && entry.summary.state !== "failed") {
			return cloneSummary(entry.summary);
		}
		return entry ? cloneSummary(entry.summary) : null;
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.messageStore.getSummary(taskId);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return this.messageStore.listSummaries();
	}

	listMessages(taskId: string): SessionMessage[] {
		return this.messageStore.listMessages(taskId);
	}

	async listSlashCommands(_workspacePath: string): Promise<RuntimeSlashCommand[]> {
		// Pi agent doesn't have its own slash commands yet. Builtin commands
		// (e.g. `/clear`) are merged in by the runtime API, not here.
		return [];
	}

	async loadTaskSessionMessages(taskId: string): Promise<SessionMessage[]> {
		return this.messageStore.loadMergedMessages(taskId);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return null;
		const summary = updateSummary(entry, {
			latestTurnCheckpoint: checkpoint,
			previousTurnCheckpoint: entry.summary.latestTurnCheckpoint,
		});
		this.messageStore.emitSummary(summary);
		return summary;
	}

	async dispose(): Promise<void> {
		await this.agentRuntime.dispose();
		this.pendingTurnCancelTaskIds.clear();
		await this.messageStore.dispose();
	}

	private emitTaskFailure(
		taskId: string,
		entry: KanbanTaskSessionEntry,
		context: "start" | "send",
		error: unknown,
	): void {
		const errorMessage = toErrorMessage(error);
		const systemMessage = createSessionMessage(
			taskId,
			"system",
			`Pi agent ${context} failed: ${errorMessage}. You can send another message to continue.`,
		);
		entry.messages.push(systemMessage);
		this.messageStore.emitMessage(taskId, systemMessage);
		clearActiveTurnState(entry);
		const errorSummary = updateSummary(entry, {
			state: "awaiting_review",
			reviewReason: "error",
			lastOutputAt: now(),
			lastHookAt: now(),
			warningMessage: errorMessage,
			latestHookActivity: {
				activityText: `${context === "start" ? "Start" : "Send"} failed: ${errorMessage}`,
				toolName: null,
				toolInputSummary: null,
				finalMessage: errorMessage,
				hookEventName: "agent_error",
				notificationType: null,
				source: "pi-agent",
			},
		});
		this.messageStore.emitSummary(errorSummary);
	}

	private handleTaskEvent(taskId: string, event: AgentEvent): void {
		const entry = this.messageStore.getTaskEntry(taskId);
		if (!entry) return;
		applyPiAgentEvent({
			event,
			taskId,
			entry,
			pendingTurnCancelTaskIds: this.pendingTurnCancelTaskIds,
			emitSummary: (summary: RuntimeTaskSessionSummary) => {
				this.messageStore.emitSummary(summary);
			},
			emitMessage: (eventTaskId: string, message: SessionMessage) => {
				this.messageStore.emitMessage(eventTaskId, message);
			},
		});
	}

	/**
	 * Fold a child (subagent) Agent event into (a) the subagent's own transcript — on a buffer
	 * keyed by the composite session id, reachable via `useTaskChatMessages(compositeId)` — and
	 * (b) the parent summary's `subagents[]` projection (status/tokens). The parent summary re-emit
	 * rides the normal broadcast path, so no new wire is needed.
	 */
	private handleSubagentEvent(info: PiSubagentEventInfo, event: AgentEvent): void {
		// (a) Per-subagent transcript on its own (summary-less) buffer.
		const subEntry = this.messageStore.getOrCreateSubagentEntry(info.compositeId);
		applyPiAgentEvent({
			event,
			taskId: info.compositeId,
			entry: subEntry,
			pendingTurnCancelTaskIds: this.noSubagentTurnCancel,
			// Subagents own no top-level summary — swallow the summary emits (the projection below
			// is what the rail reads); still broadcast the transcript messages.
			emitSummary: () => {},
			emitMessage: (eventTaskId: string, message: SessionMessage) => {
				this.messageStore.emitMessage(eventTaskId, message);
			},
		});

		// (b) Project status/tokens onto the parent summary.
		const parentEntry = this.messageStore.getTaskEntry(info.parentTaskId);
		if (!parentEntry) return;
		const subagents = applySubagentLifecycle(parentEntry.summary, info.subagentId, event, {
			compositeId: info.compositeId,
			label: info.label,
			modelId: info.modelId,
		});
		// Roll a finished subagent's tokens up into the parent's cumulative usage (the parent's own
		// agent_end telemetry covers only the parent model's calls, not the children's).
		const rolledUsage =
			event.type === "agent_end"
				? (accumulateUsage(parentEntry.summary.usage, event.telemetry) ?? parentEntry.summary.usage)
				: parentEntry.summary.usage;
		const summary = updateSummary(parentEntry, { subagents, usage: rolledUsage });
		this.messageStore.emitSummary(summary);
	}
}

export function createInMemoryPiTaskSessionService(
	options: CreatePiTaskSessionServiceOptions = {},
): PiTaskSessionService {
	return new InMemoryPiTaskSessionService(options);
}
