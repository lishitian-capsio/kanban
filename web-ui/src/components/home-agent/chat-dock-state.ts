// Pure dock-state model for the home chat panel.
//
// `dock` is the docked presentation: left | right | float. The reducer keeps
// `lastDockedSide` around while floating so closing the float window can restore
// the side the user last docked to. Fullscreen is NOT a dock position — it is an
// orthogonal axis routed through the URL (see `use-fullscreen-chat-navigation`):
// when fullscreen, the workspace overlays everything regardless of this dock
// state, which is restored unchanged on exit. Two further axes are orthogonal to
// `position`:
//   - `collapsed`: a docked panel shrunk to a thin edge strip (still present,
//     one click to expand). Only meaningful while docked, so `float` clears it
//     and `collapse` is a no-op for it.
//   - `open`: whether the panel is shown at all. Closing hides it entirely; the
//     top-bar toggle reopens it (always expanded, never lost).
// Everything here is side-effect free and unit-tested; persistence and DOM live
// in use-chat-dock / dockable-chat-panel.

export type ChatDockPosition = "left" | "right" | "float";
export type ChatDockSide = "left" | "right";

export interface ChatFloatRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const DEFAULT_CHAT_DOCK_POSITION: ChatDockPosition = "right";
export const DEFAULT_CHAT_DOCK_SIDE: ChatDockSide = "right";
export const DEFAULT_CHAT_DOCK_COLLAPSED = false;
export const DEFAULT_CHAT_DOCK_OPEN = true;

// Width of the collapsed edge strip (just the expand affordance, no chat).
export const CHAT_DOCK_COLLAPSED_WIDTH = 40;

export const DEFAULT_CHAT_DOCK_WIDTH = 380;
export const MIN_CHAT_DOCK_WIDTH = 280;
export const MAX_CHAT_DOCK_WIDTH = 640;

export const MIN_CHAT_FLOAT_WIDTH = 320;
export const MIN_CHAT_FLOAT_HEIGHT = 360;
export const DEFAULT_CHAT_FLOAT_RECT: ChatFloatRect = {
	x: 96,
	y: 88,
	width: 420,
	height: 560,
};

export function normalizeChatDockPosition(value: unknown): ChatDockPosition | null {
	if (value === "left" || value === "right" || value === "float") {
		return value;
	}
	return null;
}

export function normalizeChatDockSide(value: unknown): ChatDockSide | null {
	if (value === "left" || value === "right") {
		return value;
	}
	return null;
}

export function clampChatDockWidth(width: number): number {
	if (Number.isNaN(width)) {
		return DEFAULT_CHAT_DOCK_WIDTH;
	}
	return Math.min(MAX_CHAT_DOCK_WIDTH, Math.max(MIN_CHAT_DOCK_WIDTH, Math.round(width)));
}

function clampFloatDimension(value: number, min: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.max(min, Math.round(value));
}

function clampFloatCoordinate(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.round(value));
}

export function normalizeChatFloatRect(value: unknown): ChatFloatRect {
	if (!value || typeof value !== "object") {
		return { ...DEFAULT_CHAT_FLOAT_RECT };
	}
	const candidate = value as Partial<ChatFloatRect>;
	if (
		typeof candidate.x !== "number" ||
		typeof candidate.y !== "number" ||
		typeof candidate.width !== "number" ||
		typeof candidate.height !== "number" ||
		!Number.isFinite(candidate.x) ||
		!Number.isFinite(candidate.y) ||
		!Number.isFinite(candidate.width) ||
		!Number.isFinite(candidate.height)
	) {
		return { ...DEFAULT_CHAT_FLOAT_RECT };
	}
	return {
		x: clampFloatCoordinate(candidate.x),
		y: clampFloatCoordinate(candidate.y),
		width: clampFloatDimension(candidate.width, MIN_CHAT_FLOAT_WIDTH),
		height: clampFloatDimension(candidate.height, MIN_CHAT_FLOAT_HEIGHT),
	};
}

export interface ChatDockState {
	position: ChatDockPosition;
	lastDockedSide: ChatDockSide;
	collapsed: boolean;
	open: boolean;
}

export type ChatDockAction =
	| { type: "dock"; side: ChatDockSide }
	| { type: "float" }
	| { type: "close" }
	| { type: "collapse" }
	| { type: "expand" }
	| { type: "hide" }
	| { type: "reopen" };

export function chatDockReducer(state: ChatDockState, action: ChatDockAction): ChatDockState {
	switch (action.type) {
		// Picking a docked side or floating always implies the panel is visible.
		case "dock":
			return { ...state, position: action.side, lastDockedSide: action.side, open: true };
		case "float":
			// Floating has its own window chrome; there is no collapsed float.
			return { ...state, position: "float", collapsed: false, open: true };
		// Existing float "close" (X) returns to the last docked side, never hides.
		case "close":
			return { ...state, position: state.lastDockedSide, open: true };
		// Collapse is a docked-only edge strip; ignore it while floating.
		case "collapse":
			return state.position === "float" ? state : { ...state, collapsed: true };
		case "expand":
			return { ...state, collapsed: false };
		// Hide removes the panel entirely; reopen always brings it back expanded
		// so it can never be stuck collapsed-and-hidden with no way out.
		case "hide":
			return { ...state, open: false };
		case "reopen":
			return { ...state, open: true, collapsed: false };
		default:
			return state;
	}
}
