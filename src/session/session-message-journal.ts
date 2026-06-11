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
//   2. Bounded disk — on read, lines are de-duplicated by id (last write wins)
//      and the transcript is capped at `maxMessages`; over-cap or redundant logs
//      are compacted in place and a `status` truncation marker is surfaced.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runtimeTaskChatMessageSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { cloneSessionMessage, type SessionMessage } from "./session-message";

const DEFAULT_FLUSH_DELAY_MS = 250;
const DEFAULT_MAX_MESSAGES = 10_000;
const MESSAGES_FILENAME = "messages.jsonl";

export interface SessionMessageJournal {
	/** Persist a message. Coalesces consecutive same-id updates; never throws. */
	recordMessage(taskId: string, message: SessionMessage): void;
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
	private readonly onInfo?: (message: string) => void;

	private readonly tails = new Map<string, SessionMessage>();
	private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly writeChains = new Map<string, Promise<void>>();
	private readonly lastAppended = new Map<string, LastAppended>();

	constructor(options: FileSessionMessageJournalOptions) {
		this.sessionsDir = options.sessionsDir;
		this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
		this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
		this.onInfo = options.onInfo;
	}

	private taskDirectory(taskId: string): string {
		return join(this.sessionsDir, sanitizeTaskId(taskId));
	}

	private messagesPath(taskId: string): string {
		return join(this.taskDirectory(taskId), MESSAGES_FILENAME);
	}

	recordMessage(taskId: string, message: SessionMessage): void {
		const clone = cloneSessionMessage(message);
		const tail = this.tails.get(taskId);
		if (tail && tail.id !== clone.id) {
			// The previous message is now final — persist it before switching tails.
			this.enqueueAppend(taskId, tail);
		}
		this.tails.set(taskId, clone);
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

	private async readAndCompact(taskId: string): Promise<SessionMessage[]> {
		const raw = await readFileIfExists(this.messagesPath(taskId));
		if (raw === null) {
			return [];
		}
		const { messages, rawCount } = this.parseTranscript(raw);

		let kept = messages;
		let omitted = 0;
		if (kept.length > this.maxMessages) {
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
		const chain = this.writeChains.get(taskId) ?? Promise.resolve();
		const next = chain.then(() => rm(this.messagesPath(taskId), { force: true })).catch(() => undefined);
		this.writeChains.set(taskId, next);
		await next;
	}

	async flush(): Promise<void> {
		for (const timer of this.flushTimers.values()) {
			clearTimeout(timer);
		}
		this.flushTimers.clear();
		for (const [taskId, tail] of this.tails) {
			this.enqueueAppend(taskId, tail);
		}
		await Promise.all([...this.writeChains.values()]);
	}

	async dispose(): Promise<void> {
		await this.flush();
	}
}

export class NoopSessionMessageJournal implements SessionMessageJournal {
	recordMessage(_taskId: string, _message: SessionMessage): void {}
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
