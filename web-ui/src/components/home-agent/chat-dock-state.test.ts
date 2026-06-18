import { describe, expect, it } from "vitest";

import {
	chatDockReducer,
	clampChatDockWidth,
	DEFAULT_CHAT_DOCK_POSITION,
	DEFAULT_CHAT_DOCK_SIDE,
	DEFAULT_CHAT_FLOAT_RECT,
	MAX_CHAT_DOCK_WIDTH,
	MIN_CHAT_DOCK_WIDTH,
	MIN_CHAT_FLOAT_HEIGHT,
	MIN_CHAT_FLOAT_WIDTH,
	normalizeChatDockPosition,
	normalizeChatDockSide,
	normalizeChatFloatRect,
} from "@/components/home-agent/chat-dock-state";

describe("normalizeChatDockPosition", () => {
	it("accepts the three known positions", () => {
		expect(normalizeChatDockPosition("left")).toBe("left");
		expect(normalizeChatDockPosition("right")).toBe("right");
		expect(normalizeChatDockPosition("float")).toBe("float");
	});

	it("rejects unknown values", () => {
		expect(normalizeChatDockPosition("bottom")).toBeNull();
		expect(normalizeChatDockPosition("")).toBeNull();
		expect(normalizeChatDockPosition("LEFT")).toBeNull();
	});
});

describe("normalizeChatDockSide", () => {
	it("accepts only left/right (not float)", () => {
		expect(normalizeChatDockSide("left")).toBe("left");
		expect(normalizeChatDockSide("right")).toBe("right");
		expect(normalizeChatDockSide("float")).toBeNull();
		expect(normalizeChatDockSide("nonsense")).toBeNull();
	});
});

describe("clampChatDockWidth", () => {
	it("clamps to the configured range", () => {
		expect(clampChatDockWidth(MIN_CHAT_DOCK_WIDTH - 50)).toBe(MIN_CHAT_DOCK_WIDTH);
		expect(clampChatDockWidth(MAX_CHAT_DOCK_WIDTH + 50)).toBe(MAX_CHAT_DOCK_WIDTH);
		expect(clampChatDockWidth(360)).toBe(360);
	});

	it("falls back to default-ish width for non-finite input", () => {
		expect(clampChatDockWidth(Number.NaN)).toBeGreaterThanOrEqual(MIN_CHAT_DOCK_WIDTH);
		expect(clampChatDockWidth(Number.POSITIVE_INFINITY)).toBe(MAX_CHAT_DOCK_WIDTH);
	});
});

describe("normalizeChatFloatRect", () => {
	it("enforces minimum float size", () => {
		const rect = normalizeChatFloatRect({ x: 10, y: 20, width: 10, height: 10 });
		expect(rect.x).toBe(10);
		expect(rect.y).toBe(20);
		expect(rect.width).toBe(MIN_CHAT_FLOAT_WIDTH);
		expect(rect.height).toBe(MIN_CHAT_FLOAT_HEIGHT);
	});

	it("keeps valid larger sizes and falls back on garbage", () => {
		const rect = normalizeChatFloatRect({ x: 100, y: 50, width: 500, height: 700 });
		expect(rect).toEqual({ x: 100, y: 50, width: 500, height: 700 });
		expect(normalizeChatFloatRect(null)).toEqual(DEFAULT_CHAT_FLOAT_RECT);
		expect(normalizeChatFloatRect({ x: Number.NaN } as unknown)).toEqual(DEFAULT_CHAT_FLOAT_RECT);
	});

	it("clamps negative coordinates to zero", () => {
		const rect = normalizeChatFloatRect({ x: -40, y: -10, width: 400, height: 500 });
		expect(rect.x).toBe(0);
		expect(rect.y).toBe(0);
	});
});

describe("chatDockReducer", () => {
	const base = { position: DEFAULT_CHAT_DOCK_POSITION, lastDockedSide: DEFAULT_CHAT_DOCK_SIDE } as const;

	it("docking to a side sets both position and lastDockedSide", () => {
		expect(chatDockReducer(base, { type: "dock", side: "left" })).toEqual({
			position: "left",
			lastDockedSide: "left",
		});
		expect(chatDockReducer(base, { type: "dock", side: "right" })).toEqual({
			position: "right",
			lastDockedSide: "right",
		});
	});

	it("floating keeps the last docked side so close can restore it", () => {
		const docked = chatDockReducer(base, { type: "dock", side: "left" });
		const floated = chatDockReducer(docked, { type: "float" });
		expect(floated).toEqual({ position: "float", lastDockedSide: "left" });
	});

	it("closing the float returns to the last docked side", () => {
		const floated = { position: "float", lastDockedSide: "left" } as const;
		expect(chatDockReducer(floated, { type: "close" })).toEqual({
			position: "left",
			lastDockedSide: "left",
		});
	});

	it("defaults dock to the right side", () => {
		expect(DEFAULT_CHAT_DOCK_POSITION).toBe("right");
		expect(DEFAULT_CHAT_DOCK_SIDE).toBe("right");
	});
});
