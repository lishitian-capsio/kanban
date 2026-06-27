import { describe, expect, it } from "vitest";

import {
	deriveHomeSessionCardPreview,
	deriveHomeSessionCardStatus,
	formatHomeSessionCardTimeAgo,
	mergeHomeSessionCardMessages,
} from "@/components/home-agent/home-session-card-derive";
import type { RuntimeTaskChatMessage, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";

function makeSummary(state: RuntimeTaskSessionState): RuntimeTaskSessionSummary {
	return {
		taskId: "t",
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
	};
}

function makeMessage(overrides: Partial<RuntimeTaskChatMessage> & { id: string }): RuntimeTaskChatMessage {
	return {
		id: overrides.id,
		role: overrides.role ?? "assistant",
		content: overrides.content ?? "",
		createdAt: overrides.createdAt ?? 0,
		...(overrides.meta ? { meta: overrides.meta } : {}),
	};
}

describe("deriveHomeSessionCardStatus", () => {
	it("maps running to a pulsing blue dot", () => {
		const descriptor = deriveHomeSessionCardStatus(makeSummary("running"));
		expect(descriptor.status).toBe("running");
		expect(descriptor.pulse).toBe(true);
		expect(descriptor.dotClassName).toContain("status-blue");
	});

	it("maps awaiting_review to an orange dot, no pulse", () => {
		const descriptor = deriveHomeSessionCardStatus(makeSummary("awaiting_review"));
		expect(descriptor.status).toBe("awaiting-review");
		expect(descriptor.pulse).toBe(false);
		expect(descriptor.dotClassName).toContain("status-orange");
	});

	it("maps failed and interrupted to the error bucket (red)", () => {
		expect(deriveHomeSessionCardStatus(makeSummary("failed")).status).toBe("error");
		expect(deriveHomeSessionCardStatus(makeSummary("interrupted")).status).toBe("error");
		expect(deriveHomeSessionCardStatus(makeSummary("failed")).dotClassName).toContain("status-red");
	});

	it("treats idle and a missing summary as the muted idle dot", () => {
		expect(deriveHomeSessionCardStatus(makeSummary("idle")).status).toBe("idle");
		expect(deriveHomeSessionCardStatus(null).status).toBe("idle");
		expect(deriveHomeSessionCardStatus(null).pulse).toBe(false);
	});
});

describe("deriveHomeSessionCardPreview", () => {
	it("returns null for an empty or message-less transcript", () => {
		expect(deriveHomeSessionCardPreview(null)).toBeNull();
		expect(deriveHomeSessionCardPreview([])).toBeNull();
	});

	it("picks the newest user/assistant line and collapses whitespace", () => {
		const preview = deriveHomeSessionCardPreview([
			makeMessage({ id: "1", role: "user", content: "first", createdAt: 1 }),
			makeMessage({ id: "2", role: "assistant", content: "  multi\n  line\treply  ", createdAt: 2 }),
		]);
		expect(preview).toEqual({ role: "assistant", text: "multi line reply", createdAt: 2 });
	});

	it("skips tool/reasoning/system/status and empty rows", () => {
		const preview = deriveHomeSessionCardPreview([
			makeMessage({ id: "1", role: "user", content: "real question", createdAt: 1 }),
			makeMessage({ id: "2", role: "tool", content: "tool output", createdAt: 5 }),
			makeMessage({ id: "3", role: "reasoning", content: "thinking", createdAt: 6 }),
			makeMessage({ id: "4", role: "assistant", content: "   ", createdAt: 7 }),
		]);
		expect(preview?.text).toBe("real question");
	});

	it("selects by createdAt, not array order", () => {
		const preview = deriveHomeSessionCardPreview([
			makeMessage({ id: "2", role: "assistant", content: "newer", createdAt: 20 }),
			makeMessage({ id: "1", role: "user", content: "older", createdAt: 10 }),
		]);
		expect(preview?.text).toBe("newer");
	});
});

describe("mergeHomeSessionCardMessages", () => {
	it("unions by id with live winning, sorted by createdAt", () => {
		const historical = [
			makeMessage({ id: "a", content: "old-a", createdAt: 1 }),
			makeMessage({ id: "b", content: "stale-b", createdAt: 2 }),
		];
		const live = [
			makeMessage({ id: "b", content: "fresh-b", createdAt: 2 }),
			makeMessage({ id: "c", content: "live-c", createdAt: 3 }),
		];
		const merged = mergeHomeSessionCardMessages(historical, live);
		expect(merged.map((message) => message.id)).toEqual(["a", "b", "c"]);
		expect(merged.find((message) => message.id === "b")?.content).toBe("fresh-b");
	});

	it("tolerates null inputs", () => {
		expect(mergeHomeSessionCardMessages(null, null)).toEqual([]);
		expect(mergeHomeSessionCardMessages([makeMessage({ id: "x" })], null)).toHaveLength(1);
	});
});

describe("formatHomeSessionCardTimeAgo", () => {
	const now = 1_000_000_000_000;

	it("returns empty for a missing/invalid timestamp", () => {
		expect(formatHomeSessionCardTimeAgo(null, now)).toBe("");
		expect(formatHomeSessionCardTimeAgo(0, now)).toBe("");
	});

	it("reads 'just now' under five seconds", () => {
		expect(formatHomeSessionCardTimeAgo(now - 2_000, now)).toBe("just now");
	});

	it("formats seconds, minutes, hours, days, weeks", () => {
		expect(formatHomeSessionCardTimeAgo(now - 30_000, now)).toBe("30s");
		expect(formatHomeSessionCardTimeAgo(now - 5 * 60_000, now)).toBe("5m");
		expect(formatHomeSessionCardTimeAgo(now - 2 * 3_600_000, now)).toBe("2h");
		expect(formatHomeSessionCardTimeAgo(now - 3 * 86_400_000, now)).toBe("3d");
		expect(formatHomeSessionCardTimeAgo(now - 14 * 86_400_000, now)).toBe("2w");
	});
});
