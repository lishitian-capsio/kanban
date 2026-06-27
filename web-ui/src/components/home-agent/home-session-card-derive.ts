// Pure, side-effect-free derivations for the fullscreen Home-tab session cards.
//
// A session card is a dashboard tile for one home chat thread. Its two live
// signals — the status dot and the latest-message preview — are derived from the
// SAME per-thread session/transcript state the rest of the app already streams,
// so the card adds no data model (see the "drive the home agent chat layout by
// panel size" decision). Keeping the derivation pure makes the status semantics
// unit-testable and decoupled from React.
import type { RuntimeTaskChatMessage, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";

/**
 * The status-dot vocabulary surfaced on a session card. Collapses the richer
 * runtime session states into the three dashboard semantics the decision calls
 * out (running / awaiting-review / idle) plus an explicit error bucket so a
 * failed/interrupted session is never silently shown as idle.
 */
export type HomeSessionCardStatus = "running" | "awaiting-review" | "idle" | "error";

export interface HomeSessionCardStatusDescriptor {
	status: HomeSessionCardStatus;
	/** Human label for the dot (also the dot's accessible name). */
	label: string;
	/** Tailwind background-color class for the dot. */
	dotClassName: string;
	/** Whether the dot animates — reserved for active work (running). */
	pulse: boolean;
}

/**
 * Map a thread's session summary to its dashboard status descriptor.
 *
 * Semantics (recorded here as the source of truth for the card):
 *   - `running`          → the agent is actively working — blue, pulsing.
 *   - `awaiting_review`  → the agent finished a turn and wants attention — orange.
 *   - `failed`/`interrupted` → something went wrong / was cut off — red.
 *   - `idle` or no session yet → quiet, never started or settled — muted gray.
 */
export function deriveHomeSessionCardStatus(
	summary: RuntimeTaskSessionSummary | null,
): HomeSessionCardStatusDescriptor {
	const state: RuntimeTaskSessionState | null = summary?.state ?? null;
	switch (state) {
		case "running":
			return { status: "running", label: "Running", dotClassName: "bg-status-blue", pulse: true };
		case "awaiting_review":
			return { status: "awaiting-review", label: "Awaiting review", dotClassName: "bg-status-orange", pulse: false };
		case "failed":
			return { status: "error", label: "Failed", dotClassName: "bg-status-red", pulse: false };
		case "interrupted":
			return { status: "error", label: "Interrupted", dotClassName: "bg-status-red", pulse: false };
		default:
			return { status: "idle", label: "Idle", dotClassName: "bg-text-tertiary", pulse: false };
	}
}

export interface HomeSessionCardMessagePreview {
	role: "user" | "assistant";
	/** Whitespace-collapsed, single-line text. Never empty. */
	text: string;
	createdAt: number;
}

// Roles that carry a human-meaningful conversational line for the preview. Tool,
// reasoning, system, and status rows are plumbing — skip them so the card reads
// like "the last thing said", not the last internal event.
const PREVIEW_ROLES = new Set<RuntimeTaskChatMessage["role"]>(["user", "assistant"]);

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Pick the newest meaningful (user/assistant) line from a transcript for the
 * card preview. Returns null when the thread has no conversational message yet.
 * Robust to out-of-order arrays — selects by `createdAt`, not array position.
 */
export function deriveHomeSessionCardPreview(
	messages: readonly RuntimeTaskChatMessage[] | null | undefined,
): HomeSessionCardMessagePreview | null {
	if (!messages || messages.length === 0) {
		return null;
	}
	let best: HomeSessionCardMessagePreview | null = null;
	for (const message of messages) {
		if (!PREVIEW_ROLES.has(message.role)) {
			continue;
		}
		const text = collapseWhitespace(message.content);
		if (text.length === 0) {
			continue;
		}
		if (!best || message.createdAt >= best.createdAt) {
			best = { role: message.role as "user" | "assistant", text, createdAt: message.createdAt };
		}
	}
	return best;
}

/**
 * Merge two transcript snapshots for one thread by id (last write wins),
 * preserving chronological order. The card holds a one-shot history fetch and a
 * live broadcast stream; neither alone is complete (the fetch lacks tokens that
 * arrived after it, the live store only holds messages seen since connect), so
 * the preview is derived from their union.
 */
export function mergeHomeSessionCardMessages(
	historical: readonly RuntimeTaskChatMessage[] | null | undefined,
	live: readonly RuntimeTaskChatMessage[] | null | undefined,
): RuntimeTaskChatMessage[] {
	const byId = new Map<string, RuntimeTaskChatMessage>();
	for (const message of historical ?? []) {
		byId.set(message.id, message);
	}
	for (const message of live ?? []) {
		byId.set(message.id, message);
	}
	return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

const RELATIVE_TIME_THRESHOLDS: ReadonlyArray<{ limitMs: number; divisorMs: number; unit: string }> = [
	{ limitMs: 60_000, divisorMs: 1_000, unit: "s" },
	{ limitMs: 3_600_000, divisorMs: 60_000, unit: "m" },
	{ limitMs: 86_400_000, divisorMs: 3_600_000, unit: "h" },
	{ limitMs: 604_800_000, divisorMs: 86_400_000, unit: "d" },
];

/**
 * Compact "time ago" label for a card's last-activity timestamp (e.g. "5m",
 * "2h", "3d"). Returns "just now" under 5s and an empty string for a missing
 * timestamp so callers can omit the element entirely.
 */
export function formatHomeSessionCardTimeAgo(timestampMs: number | null | undefined, nowMs: number): string {
	if (timestampMs == null || !Number.isFinite(timestampMs) || timestampMs <= 0) {
		return "";
	}
	const elapsedMs = Math.max(0, nowMs - timestampMs);
	if (elapsedMs < 5_000) {
		return "just now";
	}
	for (const { limitMs, divisorMs, unit } of RELATIVE_TIME_THRESHOLDS) {
		if (elapsedMs < limitMs) {
			return `${Math.floor(elapsedMs / divisorMs)}${unit}`;
		}
	}
	return `${Math.floor(elapsedMs / 604_800_000)}w`;
}
