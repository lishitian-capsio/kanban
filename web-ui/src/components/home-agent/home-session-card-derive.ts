// Pure, side-effect-free derivations for the fullscreen Home-tab session cards.
//
// A session card is a dashboard tile for one home chat thread. Its two live
// signals — the status dot and the latest-message preview — are derived from the
// SAME per-thread session/transcript state the rest of the app already streams,
// so the card adds no data model (see the "drive the home agent chat layout by
// panel size" decision). Keeping the derivation pure makes the status semantics
// unit-testable and decoupled from React.
import type {
	RuntimeTaskChatMessage,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSubagentStatus,
} from "@/runtime/types";
import { isCardCreditLimitError } from "@/utils/session-activity";

/**
 * The status vocabulary surfaced on a session card. A home chat has no review
 * concept, so the runtime `awaiting_review` state (a finished turn) collapses into
 * `idle` ("your turn") — leaving just running / idle plus an explicit error bucket
 * so a failed/interrupted session is never silently shown as idle.
 */
export type HomeSessionCardStatus = "running" | "idle" | "error";

/**
 * Which visual marker the card renders in its status slot, mirroring the board
 * task card (`board-card.tsx`): a real `Spinner` while running, a red
 * `AlertCircle` on failure, an orange `AlertTriangle` for credit-limit, and a
 * plain colored dot for the quiet states (awaiting-review / idle).
 */
export type HomeSessionCardMarker = "spinner" | "alert-circle" | "alert-triangle" | "dot";

export interface HomeSessionCardStatusDescriptor {
	status: HomeSessionCardStatus;
	/** Human label for the marker (also its accessible name). */
	label: string;
	/** Which marker to render in the status slot. */
	marker: HomeSessionCardMarker;
	/**
	 * Tailwind color class for the marker: a `bg-*` for the `dot` kind, a `text-*`
	 * for the icon kinds. Empty for the default-tinted spinner (matches the board card).
	 */
	markerClassName: string;
	/** Whether a `dot` marker animates. The spinner animates on its own, so it never pulses. */
	pulse: boolean;
}

/**
 * Map a thread's session summary to its dashboard status descriptor.
 *
 * Semantics (recorded here as the source of truth for the card; the marker
 * kinds/tokens mirror the board task card so the two read identically):
 *   - `running`              → the agent is actively working — a spinner.
 *   - `awaiting_review`      → a home chat has NO review concept, so a finished turn
 *                              just means "your turn" — read as a calm idle dot, not
 *                              an attention state (unlike the board task card).
 *   - `failed`/`interrupted` → something went wrong / was cut off — red alert-circle.
 *   - credit-limit error     → provider out of credits — orange alert-triangle (takes
 *                              priority over the underlying failed/awaiting state, like the board card).
 *   - `idle` or no session    → quiet, never started or settled — muted gray dot.
 */
export function deriveHomeSessionCardStatus(
	summary: RuntimeTaskSessionSummary | null,
): HomeSessionCardStatusDescriptor {
	const base = deriveBaseStatus(summary?.state ?? null);
	// A credit-limit error overrides only the marker + label, keeping the underlying
	// status bucket (so a failed-on-credits session still offers restart). Checked
	// first because it can ride on either a failed/interrupted or awaiting_review state.
	if (isCardCreditLimitError(summary)) {
		return {
			...base,
			label: "Out of credits",
			marker: "alert-triangle",
			markerClassName: "text-status-orange",
			pulse: false,
		};
	}
	return base;
}

function deriveBaseStatus(state: RuntimeTaskSessionState | null): HomeSessionCardStatusDescriptor {
	switch (state) {
		case "running":
			return { status: "running", label: "Running", marker: "spinner", markerClassName: "", pulse: false };
		case "awaiting_review":
			// Home chat has no review: a finished turn is "your turn", rendered as the
			// same quiet idle dot as a never-started thread (only the label differs so
			// the badge tooltip still reads "your turn"). Critically NOT the orange
			// attention dot the board card uses — see this function's doc comment.
			return {
				status: "idle",
				label: "Your turn",
				marker: "dot",
				markerClassName: "bg-text-tertiary",
				pulse: false,
			};
		case "failed":
			return {
				status: "error",
				label: "Failed",
				marker: "alert-circle",
				markerClassName: "text-status-red",
				pulse: false,
			};
		case "interrupted":
			return {
				status: "error",
				label: "Interrupted",
				marker: "alert-circle",
				markerClassName: "text-status-red",
				pulse: false,
			};
		default:
			return { status: "idle", label: "Idle", marker: "dot", markerClassName: "bg-text-tertiary", pulse: false };
	}
}

/**
 * Map a Pi subagent's lifecycle status to the same status descriptor the session
 * surfaces use, so the subagents rail renders with the identical marker vocabulary
 * as the cards/tabs. A subagent has its own `idle|running|done|failed` enum (it is a
 * spawn-and-forget child run, not a reviewable session): `done` is a settled success
 * (a green dot, distinct from the gray idle dot), `failed` a red alert.
 */
export function deriveSubagentStatus(status: RuntimeTaskSubagentStatus): HomeSessionCardStatusDescriptor {
	switch (status) {
		case "running":
			return { status: "running", label: "Running", marker: "spinner", markerClassName: "", pulse: false };
		case "done":
			return { status: "idle", label: "Done", marker: "dot", markerClassName: "bg-status-green", pulse: false };
		case "failed":
			return {
				status: "error",
				label: "Failed",
				marker: "alert-circle",
				markerClassName: "text-status-red",
				pulse: false,
			};
		default:
			return { status: "idle", label: "Idle", marker: "dot", markerClassName: "bg-text-tertiary", pulse: false };
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
