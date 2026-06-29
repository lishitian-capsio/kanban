// Persisted dock state for the home chat panel.
//
// Holds `position` (left | right | float), the `lastDockedSide` used to restore
// the panel when the float window is closed, the docked column `width`, the
// floating window `rect`, whether the docked panel is `collapsed` to its edge
// strip, and whether the panel is `open` at all. Every value persists to
// localStorage so the panel keeps its placement and visibility across reloads.
// The transition semantics live in the pure `chat-dock-state` reducer; this
// hook only wires persistence and callbacks.
import { useCallback, useMemo } from "react";

import {
	type ChatDockPosition,
	type ChatDockSide,
	type ChatFloatRect,
	chatDockReducer,
	clampChatDockWidth,
	DEFAULT_CHAT_DOCK_COLLAPSED,
	DEFAULT_CHAT_DOCK_OPEN,
	DEFAULT_CHAT_DOCK_POSITION,
	DEFAULT_CHAT_DOCK_SIDE,
	DEFAULT_CHAT_DOCK_WIDTH,
	DEFAULT_CHAT_FLOAT_RECT,
	normalizeChatDockPosition,
	normalizeChatDockSide,
	normalizeChatFloatRect,
} from "@/components/home-agent/chat-dock-state";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue, useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

export interface UseChatDockResult {
	position: ChatDockPosition;
	lastDockedSide: ChatDockSide;
	width: number;
	floatRect: ChatFloatRect;
	collapsed: boolean;
	open: boolean;
	dockLeft: () => void;
	dockRight: () => void;
	floatPanel: () => void;
	closeFloat: () => void;
	collapse: () => void;
	expand: () => void;
	hide: () => void;
	reopen: () => void;
	setWidth: (width: number) => void;
	setFloatRect: (rect: ChatFloatRect) => void;
}

function normalizeWidth(value: unknown): number {
	return typeof value === "number" ? clampChatDockWidth(value) : DEFAULT_CHAT_DOCK_WIDTH;
}

export function useChatDock(): UseChatDockResult {
	const [position, setPosition] = useRawLocalStorageValue<ChatDockPosition>(
		LocalStorageKey.ChatDockPosition,
		DEFAULT_CHAT_DOCK_POSITION,
		normalizeChatDockPosition,
	);
	const [lastDockedSide, setLastDockedSide] = useRawLocalStorageValue<ChatDockSide>(
		LocalStorageKey.ChatDockLastSide,
		DEFAULT_CHAT_DOCK_SIDE,
		normalizeChatDockSide,
	);
	const [width, setWidthRaw] = useJsonLocalStorageValue<number>(
		LocalStorageKey.ChatDockWidth,
		DEFAULT_CHAT_DOCK_WIDTH,
		normalizeWidth,
	);
	const [floatRect, setFloatRectRaw] = useJsonLocalStorageValue<ChatFloatRect>(
		LocalStorageKey.ChatDockFloatRect,
		DEFAULT_CHAT_FLOAT_RECT,
		normalizeChatFloatRect,
	);
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.ChatDockCollapsed,
		DEFAULT_CHAT_DOCK_COLLAPSED,
	);
	const [open, setOpen] = useBooleanLocalStorageValue(LocalStorageKey.ChatDockOpen, DEFAULT_CHAT_DOCK_OPEN);

	const applyTransition = useCallback(
		(action: Parameters<typeof chatDockReducer>[1]) => {
			const next = chatDockReducer({ position, lastDockedSide, collapsed, open }, action);
			setPosition(next.position);
			setLastDockedSide(next.lastDockedSide);
			setCollapsed(next.collapsed);
			setOpen(next.open);
		},
		[position, lastDockedSide, collapsed, open, setPosition, setLastDockedSide, setCollapsed, setOpen],
	);

	const dockLeft = useCallback(() => applyTransition({ type: "dock", side: "left" }), [applyTransition]);
	const dockRight = useCallback(() => applyTransition({ type: "dock", side: "right" }), [applyTransition]);
	const floatPanel = useCallback(() => applyTransition({ type: "float" }), [applyTransition]);
	const closeFloat = useCallback(() => applyTransition({ type: "close" }), [applyTransition]);
	const collapse = useCallback(() => applyTransition({ type: "collapse" }), [applyTransition]);
	const expand = useCallback(() => applyTransition({ type: "expand" }), [applyTransition]);
	const hide = useCallback(() => applyTransition({ type: "hide" }), [applyTransition]);
	const reopen = useCallback(() => applyTransition({ type: "reopen" }), [applyTransition]);

	const setWidth = useCallback((next: number) => setWidthRaw(clampChatDockWidth(next)), [setWidthRaw]);
	const setFloatRect = useCallback(
		(next: ChatFloatRect) => setFloatRectRaw(normalizeChatFloatRect(next)),
		[setFloatRectRaw],
	);

	return useMemo(
		() => ({
			position,
			lastDockedSide,
			width,
			floatRect,
			collapsed,
			open,
			dockLeft,
			dockRight,
			floatPanel,
			closeFloat,
			collapse,
			expand,
			hide,
			reopen,
			setWidth,
			setFloatRect,
		}),
		[
			position,
			lastDockedSide,
			width,
			floatRect,
			collapsed,
			open,
			dockLeft,
			dockRight,
			floatPanel,
			closeFloat,
			collapse,
			expand,
			hide,
			reopen,
			setWidth,
			setFloatRect,
		],
	);
}
