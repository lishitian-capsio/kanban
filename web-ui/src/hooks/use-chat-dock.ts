// Persisted dock state for the home chat panel.
//
// Holds `position` (left | right | float), the `lastDockedSide` used to restore
// the panel when the float window is closed, the docked column `width`, and the
// floating window `rect`. All four values persist to localStorage so the panel
// keeps its placement across reloads. The transition semantics live in the pure
// `chat-dock-state` reducer; this hook only wires persistence and callbacks.
import { useCallback, useMemo } from "react";

import {
	type ChatDockPosition,
	type ChatDockSide,
	type ChatFloatRect,
	chatDockReducer,
	clampChatDockWidth,
	DEFAULT_CHAT_DOCK_POSITION,
	DEFAULT_CHAT_DOCK_SIDE,
	DEFAULT_CHAT_DOCK_WIDTH,
	DEFAULT_CHAT_FLOAT_RECT,
	normalizeChatDockPosition,
	normalizeChatDockSide,
	normalizeChatFloatRect,
} from "@/components/home-agent/chat-dock-state";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

export interface UseChatDockResult {
	position: ChatDockPosition;
	lastDockedSide: ChatDockSide;
	width: number;
	floatRect: ChatFloatRect;
	dockLeft: () => void;
	dockRight: () => void;
	floatPanel: () => void;
	closeFloat: () => void;
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

	const applyTransition = useCallback(
		(action: Parameters<typeof chatDockReducer>[1]) => {
			const next = chatDockReducer({ position, lastDockedSide }, action);
			setPosition(next.position);
			setLastDockedSide(next.lastDockedSide);
		},
		[position, lastDockedSide, setPosition, setLastDockedSide],
	);

	const dockLeft = useCallback(() => applyTransition({ type: "dock", side: "left" }), [applyTransition]);
	const dockRight = useCallback(() => applyTransition({ type: "dock", side: "right" }), [applyTransition]);
	const floatPanel = useCallback(() => applyTransition({ type: "float" }), [applyTransition]);
	const closeFloat = useCallback(() => applyTransition({ type: "close" }), [applyTransition]);

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
			dockLeft,
			dockRight,
			floatPanel,
			closeFloat,
			setWidth,
			setFloatRect,
		}),
		[position, lastDockedSide, width, floatRect, dockLeft, dockRight, floatPanel, closeFloat, setWidth, setFloatRect],
	);
}
