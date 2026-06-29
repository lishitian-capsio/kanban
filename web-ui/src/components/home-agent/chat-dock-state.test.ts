import { describe, expect, it } from "vitest";

import {
	type ChatDockState,
	chatDockReducer,
	clampChatDockWidth,
	DEFAULT_CHAT_DOCK_COLLAPSED,
	DEFAULT_CHAT_DOCK_OPEN,
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
	it("accepts the three docked-presentation positions", () => {
		expect(normalizeChatDockPosition("left")).toBe("left");
		expect(normalizeChatDockPosition("right")).toBe("right");
		expect(normalizeChatDockPosition("float")).toBe("float");
	});

	it("rejects unknown values and the retired fullscreen position", () => {
		// Fullscreen is no longer a dock position; it is an orthogonal URL-routed axis.
		// A value persisted by an older build normalizes away to the default.
		expect(normalizeChatDockPosition("fullscreen")).toBeNull();
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
	const base: ChatDockState = {
		position: DEFAULT_CHAT_DOCK_POSITION,
		lastDockedSide: DEFAULT_CHAT_DOCK_SIDE,
		collapsed: DEFAULT_CHAT_DOCK_COLLAPSED,
		open: DEFAULT_CHAT_DOCK_OPEN,
	};

	it("docking to a side sets both position and lastDockedSide", () => {
		expect(chatDockReducer(base, { type: "dock", side: "left" })).toEqual({
			position: "left",
			lastDockedSide: "left",
			collapsed: false,
			open: true,
		});
		expect(chatDockReducer(base, { type: "dock", side: "right" })).toEqual({
			position: "right",
			lastDockedSide: "right",
			collapsed: false,
			open: true,
		});
	});

	it("floating keeps the last docked side so close can restore it", () => {
		const docked = chatDockReducer(base, { type: "dock", side: "left" });
		const floated = chatDockReducer(docked, { type: "float" });
		expect(floated).toEqual({ position: "float", lastDockedSide: "left", collapsed: false, open: true });
	});

	it("closing the float returns to the last docked side", () => {
		const floated: ChatDockState = { position: "float", lastDockedSide: "left", collapsed: false, open: true };
		expect(chatDockReducer(floated, { type: "close" })).toEqual({
			position: "left",
			lastDockedSide: "left",
			collapsed: false,
			open: true,
		});
	});

	it("defaults dock to the right side", () => {
		expect(DEFAULT_CHAT_DOCK_POSITION).toBe("right");
		expect(DEFAULT_CHAT_DOCK_SIDE).toBe("right");
		expect(DEFAULT_CHAT_DOCK_COLLAPSED).toBe(false);
		expect(DEFAULT_CHAT_DOCK_OPEN).toBe(true);
	});

	it("collapse shrinks a docked panel to the edge strip and expand restores it", () => {
		const collapsed = chatDockReducer(base, { type: "collapse" });
		expect(collapsed).toEqual({ ...base, collapsed: true });
		expect(chatDockReducer(collapsed, { type: "expand" })).toEqual({ ...base, collapsed: false });
	});

	it("ignores collapse while floating (no collapsed float)", () => {
		const floated: ChatDockState = { position: "float", lastDockedSide: "right", collapsed: false, open: true };
		expect(chatDockReducer(floated, { type: "collapse" })).toBe(floated);
	});

	it("floating clears a collapsed docked panel", () => {
		const collapsed: ChatDockState = { position: "left", lastDockedSide: "left", collapsed: true, open: true };
		expect(chatDockReducer(collapsed, { type: "float" })).toEqual({
			position: "float",
			lastDockedSide: "left",
			collapsed: false,
			open: true,
		});
	});

	it("hide closes the panel and preserves placement", () => {
		const docked: ChatDockState = { position: "left", lastDockedSide: "left", collapsed: false, open: true };
		expect(chatDockReducer(docked, { type: "hide" })).toEqual({ ...docked, open: false });
	});

	it("reopen always brings the panel back expanded so it is never stuck", () => {
		const hiddenAndCollapsed: ChatDockState = {
			position: "right",
			lastDockedSide: "right",
			collapsed: true,
			open: false,
		};
		expect(chatDockReducer(hiddenAndCollapsed, { type: "reopen" })).toEqual({
			position: "right",
			lastDockedSide: "right",
			collapsed: false,
			open: true,
		});
	});
});
