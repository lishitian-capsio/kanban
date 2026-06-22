// Append-only, per-task persistence for the agent-agnostic session transcript.
//
// Both pi (`PiTaskSessionService`) and the CLI/terminal agents
// (`TerminalSessionManager`) emit a `SessionMessage` stream. This journal makes
// that stream durable so a transcript survives a Kanban restart and can be read
// back into the UI through the existing `getTaskChatMessages` path.
//
// Storage layout: `<sessionsDir>/<taskId>/messages.jsonl` — one JSON-encoded
// `SessionMessage` per line, append-only so we never rewrite the whole file on
// every message.
//
// Two concerns shape the design:
//   1. Streaming bloat — pi re-emits the *same* assistant message id on every
//      token (`message_update`). Naively appending each emit would write hundreds
//      of lines per message. The journal coalesces consecutive same-id updates
//      into a single pending `tail` and only appends it on an id change, a
//      debounced flush, or an explicit `flush()`.
//   2. Bounded disk — each debounced snapshot of an in-progress message appends
//      the *current* full content, so a long stream leaves many superseded lines
//      behind (all but the last are dead weight, deduped away on read). Three
//      triggers reclaim that space: a read (`loadMessages`), crossing a per-task
//      stale-line threshold mid-stream, and `flush()`/`dispose()`. On any of
//      them lines are de-duplicated by id (last write wins) and the transcript is
//      capped at `maxMessages`; over-cap data surfaces a `status` truncation
//      marker. Compaction never drops the latest content for any id, so it is
//      safe to run while a session is still streaming.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runtimeTaskChatMessageSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { cloneSessionMessage, type SessionMessage } from "./session-message";

const DEFAULT_FLUSH_DELAY_MS = 250;
const DEFAULT_MAX_MESSAGES = 10_000;
// How many superseded same-id snapshots may pile up for one task before an
// opportunistic in-place compaction is triggered mid-stream. With the default
// 250ms debounce this caps a long-running, never-read transcript to a handful
// of seconds' worth of redundant lines instead of letting it grow until the
// next read (or the `maxMessages` ceiling).
const DEFAULT_COMPACTION_STALE_THRESHOLD = 16;
const MESSAGES_FILENAME = "messages.jsonl";

export interface SessionMessageJournal {
	/** Persist a message. Coalesces consecutive same-id updates; never throws. */
	recordMessage(taskId: string, message: SessionMessage): void;
	/**
	 * Monotonic per-task counter that advances whenever the logical persisted
	 * content for a task could have changed (`recordMessage`, `clear`) and stays
	 * put across reads and content-preserving compaction. It is a cheap change
	 * token: callers cache derived results (e.g. a merged transcript) against it
	 * and recompute only when it moves, without re-reading the file.
	 */
	getGeneration(taskId: string): number;
	/** Read the durable transcript for a task (deduped by id, capped). */
	loadMessages(taskId: string): Promise<SessionMessage[]>;
	/** Drop the persisted transcript for a task. */
	clear(taskId: string): Promise<void>;
	/** Force all pending writes to disk. */
	flush(): Promise<void>;
	/** Flush and release timers. */
	dispose(): Promise<void>;
}

export interface FileSessionMessageJournalOptions {
	/** Directory that holds one `<taskId>/messages.jsonl` per session. */
	sessionsDir: string;
	/** Maximum number of messages kept per transcript (default 10k). */
	maxMessages?: number;
	/** Debounce window before an in-progress message is flushed (default 250ms). */
	flushDelayMs?: number;
	/**
	 * Superseded same-id snapshots tolerated for one task before an in-place
	 * compaction runs mid-stream (default 16). Lower trades a few extra rewrites
	 * for a tighter disk bound; higher leans on the read/flush triggers.
	 */
	compactionStaleThreshold?: number;
	/** Invoked with a human-readable note when a transcript is trimmed. */
	onInfo?: (message: string) => void;
}

interface LastAppended {
	id: string;
	content: string;
}

function sanitizeTaskId(taskId: string): string {
	if (/^[A-Za-z0-9_-]+$/.test(taskId)) {
		return taskId;
	}
	return `enc-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class FileSessionMessageJournal implements SessionMessageJournal {
	private readonly sessionsDir: string;
	private readonly maxMessages: number;
	private readonly flushDelayMs: number;
	private readonly compactionStaleThreshold: number;
	private readonly onInfo?: (message: string) => void;

	private readonly tails = new Map<string, SessionMessage>();
	private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly writeChains = new Map<string, Promise<void>>();
	private readonly lastAppended = new Map<string, LastAppended>();
	/** Count of superseded same-id lines appended since the last compaction. */
	private readonly staleAppends = new Map<string, number>();
	/** Monotonic per-task change token (see `getGeneration`). */
	private readonly generations = new Map<string, number>();

	constructor(options: FileSessionMessageJournalOptions) {
		this.sessionsDir = options.sessionsDir;
		this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
		this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
		this.compactionStaleThreshold = options.compactionStaleThreshold ?? DEFAULT_COMPACTION_STALE_THRESHOLD;
		this.onInfo = options.onInfo;
	}

	private taskDirectory(taskId: string): string {
		return join(this.sessionsDir, sanitizeTaskId(taskId));
	}

	private messagesPath(taskId: string): string {
		return join(this.taskDirectory(taskId), MESSAGES_FILENAME);
	}

	getGeneration(taskId: string): number {
		return this.generations.get(taskId) ?? 0;
	}

	private bumpGeneration(taskId: string): void {
		this.generations.set(taskId, this.getGeneration(taskId) + 1);
	}

	recordMessage(taskId: string, message: SessionMessage): void {
		const clone = cloneSessionMessage(message);
		const tail = this.tails.get(taskId);
		if (tail && tail.id !== clone.id) {
			// The previous message is now final — persist it before switching tails.
			this.enqueueAppend(taskId, tail);
		}
		this.tails.set(taskId, clone);
		this.bumpGeneration(taskId);
		this.scheduleFlush(taskId);
	}

	private scheduleFlush(taskId: string): void {
		const existing = this.flushTimers.get(taskId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.flushTimers.delete(taskId);
			const tail = this.tails.get(taskId);
			if (tail) {
				this.enqueueAppend(taskId, tail);
			}
		}, this.flushDelayMs);
		if (typeof timer.unref === "function") {
			timer.unref();
		}
		this.flushTimers.set(taskId, timer);
	}

	private enqueueAppend(taskId: string, message: SessionMessage): void {
		const chain = this.writeChains.get(taskId) ?? Promise.resolve();
		const next = chain.then(() => this.appendLine(taskId, message)).catch(() => undefined);
		this.writeChains.set(taskId, next);
	}

	private async appendLine(taskId: string, message: SessionMessage): Promise<void> {
		const last = this.lastAppended.get(taskId);
		if (last && last.id === message.id && last.content === message.content) {
			return;
		}
		await mkdir(this.taskDirectory(taskId), { recursive: true });
		await appendFile(this.messagesPath(taskId), `${JSON.stringify(message)}\n`, "utf8");
		this.lastAppended.set(taskId, { id: message.id, content: message.content });
		if (last && last.id === message.id) {
			// We just superseded the previous line for this id with longer content;
			// the old line is now dead weight that a read would dedupe away.
			const stale = (this.staleAppends.get(taskId) ?? 0) + 1;
			this.staleAppends.set(taskId, stale);
			if (stale >= this.compactionStaleThreshold) {
				await this.compactFile(taskId, { cap: false });
			}
		}
	}

	loadMessages(taskId: string): Promise<SessionMessage[]> {
		const chain = this.writeChains.get(taskId) ?? Promise.resolve();
		const result = chain.then(() => this.readAndCompact(taskId));
		this.writeChains.set(
			taskId,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	private parseTranscript(raw: string): { messages: SessionMessage[]; rawCount: number } {
		const byId = new Map<string, SessionMessage>();
		const order: string[] = [];
		let rawCount = 0;
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			const result = runtimeTaskChatMessageSchema.safeParse(parsed);
			if (!result.success) {
				continue;
			}
			rawCount += 1;
			if (!byId.has(result.data.id)) {
				order.push(result.data.id);
			}
			byId.set(result.data.id, result.data);
		}
		const messages: SessionMessage[] = [];
		for (const id of order) {
			const message = byId.get(id);
			if (message) {
				messages.push(message);
			}
		}
		return { messages, rawCount };
	}

	private createTruncationMarker(
		taskId: string,
		omitted: number,
		firstKept: SessionMessage | undefined,
	): SessionMessage {
		return {
			id: `${taskId}-transcript-truncated`,
			role: "status",
			content: `${omitted} earlier message(s) were trimmed from this transcript to bound disk usage.`,
			createdAt: firstKept?.createdAt ?? 0,
			meta: { messageKind: "transcript_truncated" },
		};
	}

	/**
	 * Read the on-disk transcript, dedupe by id (last write wins), and rewrite the
	 * file in place when that reclaims space. Shared by reads and the background
	 * (stale-threshold / flush) compaction triggers, so all paths dedupe
	 * identically and never drop the latest content for an id.
	 *
	 * `cap` enforces the `maxMessages` ceiling on distinct messages. Only the read
	 * path sets it: the cap and its `status` truncation marker are a presentation
	 * concern surfaced at read time, so background compaction leaves distinct
	 * messages intact (it only reclaims redundant same-id snapshots) and never
	 * silently trims history the reader hasn't been told about.
	 */
	private async compactFile(
		taskId: string,
		options: { cap: boolean },
	): Promise<{ kept: SessionMessage[]; omitted: number }> {
		const raw = await readFileIfExists(this.messagesPath(taskId));
		if (raw === null) {
			this.staleAppends.delete(taskId);
			return { kept: [], omitted: 0 };
		}
		const { messages, rawCount } = this.parseTranscript(raw);

		let kept = messages;
		let omitted = 0;
		if (options.cap && kept.length > this.maxMessages) {
			omitted = kept.length - this.maxMessages;
			kept = kept.slice(kept.length - this.maxMessages);
		}

		const needsCompaction = omitted > 0 || rawCount > messages.length;
		if (needsCompaction) {
			await this.rewriteTranscript(taskId, kept);
			if (omitted > 0) {
				this.onInfo?.(`Trimmed ${omitted} message(s) from transcript ${taskId}.`);
			}
		}
		this.staleAppends.delete(taskId);
		return { kept, omitted };
	}

	private async readAndCompact(taskId: string): Promise<SessionMessage[]> {
		const { kept, omitted } = await this.compactFile(taskId, { cap: true });
		if (omitted > 0) {
			return [this.createTruncationMarker(taskId, omitted, kept[0]), ...kept];
		}
		return kept;
	}

	private async rewriteTranscript(taskId: string, messages: SessionMessage[]): Promise<void> {
		const content = messages.map((message) => JSON.stringify(message)).join("\n");
		await lockedFileSystem.writeTextFileAtomic(this.messagesPath(taskId), content.length > 0 ? `${content}\n` : "");
		const last = messages.at(-1);
		if (last) {
			this.lastAppended.set(taskId, { id: last.id, content: last.content });
		} else {
			this.lastAppended.delete(taskId);
		}
	}

	async clear(taskId: string): Promise<void> {
		const timer = this.flushTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			this.flushTimers.delete(taskId);
		}
		this.tails.delete(taskId);
		this.lastAppended.delete(taskId);
		this.staleAppends.delete(taskId);
		this.bumpGeneration(taskId);
		const chain = this.writeChains.get(taskId) ?? Promise.resolve();
		const next = chain.then(() => rm(this.messagesPath(taskId), { force: true })).catch(() => undefined);
		this.writeChains.set(taskId, next);
		await next;
	}

	private enqueueCompaction(taskId: string): void {
		const chain = this.writeChains.get(taskId) ?? Promise.resolve();
		const next = chain
			.then(() => this.compactFile(taskId, { cap: false }).then(() => undefined))
			.catch(() => undefined);
		this.writeChains.set(taskId, next);
	}

	async flush(): Promise<void> {
		for (const timer of this.flushTimers.values()) {
			clearTimeout(timer);
		}
		this.flushTimers.clear();
		const candidates = new Set<string>(this.staleAppends.keys());
		for (const [taskId, tail] of this.tails) {
			// The tail append can itself supersede the last written line for this id
			// (same id, new content) — the same condition `appendLine` checks. When
			// it does, the file gains a redundant line the synchronous `staleAppends`
			// snapshot doesn't yet reflect, so mark the task for compaction too.
			const last = this.lastAppended.get(taskId);
			if (last && last.id === tail.id && last.content !== tail.content) {
				candidates.add(taskId);
			}
			this.enqueueAppend(taskId, tail);
		}
		// Reclaim any superseded snapshots that never hit the mid-stream threshold,
		// so an ending session (dispose/interrupt) leaves a compact file even when
		// its transcript is never read back. Only tasks with known redundancy are
		// compacted, so a clean transcript is never re-read just to confirm it.
		for (const taskId of candidates) {
			this.enqueueCompaction(taskId);
		}
		await Promise.all([...this.writeChains.values()]);
	}

	async dispose(): Promise<void> {
		await this.flush();
	}
}

export class NoopSessionMessageJournal implements SessionMessageJournal {
	recordMessage(_taskId: string, _message: SessionMessage): void {}
	getGeneration(_taskId: string): number {
		// Never persists, so the persisted side is always empty and never changes.
		return 0;
	}
	async loadMessages(_taskId: string): Promise<SessionMessage[]> {
		return [];
	}
	async clear(_taskId: string): Promise<void> {}
	async flush(): Promise<void> {}
	async dispose(): Promise<void> {}
}

/**
 * Merge a persisted transcript with the live in-memory buffer. Persisted order
 * is preserved; messages present in both are taken from `live` (more current),
 * and live-only messages are appended. This lets a service serve restart history
 * before its live buffer has been hydrated.
 */
export function mergeSessionMessages(persisted: SessionMessage[], live: SessionMessage[]): SessionMessage[] {
	if (live.length === 0) {
		return persisted;
	}
	const liveById = new Map(live.map((message) => [message.id, message]));
	const seen = new Set<string>();
	const merged: SessionMessage[] = [];
	for (const message of persisted) {
		const override = liveById.get(message.id);
		merged.push(override ?? message);
		seen.add(message.id);
	}
	for (const message of live) {
		if (!seen.has(message.id)) {
			merged.push(message);
		}
	}
	return merged;
}
