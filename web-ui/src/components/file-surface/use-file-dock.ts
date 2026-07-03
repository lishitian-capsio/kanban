// Persisted dock state for the File surface's filesystem panel.
//
// Mirrors the home chat's dock (`use-chat-dock`) but only the left/right axis the
// File surface needs — no float window, no fullscreen. Open/close is NOT owned
// here: it is URL-routed via `?files` in `fileSurfaceStore` (so the panel is
// shareable and refresh-survivable), and this hook only persists placement:
// which side it docks to, the docked column `width`, and whether it is
// `collapsed` to its edge strip. Every value persists to localStorage.
import { useCallback, useMemo } from "react";

import { normalizeChatDockSide } from "@/components/home-agent/chat-dock-state";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue, useJsonLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";

export type FileDockSide = "left" | "right";

// The filesystem explorer is a two-pane (tree + viewer/editor) surface, so it
// wants more room than the chat dock; give it a wider default and ceiling.
export const DEFAULT_FILE_DOCK_SIDE: FileDockSide = "right";
export const DEFAULT_FILE_DOCK_COLLAPSED = false;
export const FILE_DOCK_COLLAPSED_WIDTH = 40;
export const DEFAULT_FILE_DOCK_WIDTH = 560;
export const MIN_FILE_DOCK_WIDTH = 360;
export const MAX_FILE_DOCK_WIDTH = 960;

export function clampFileDockWidth(width: number): number {
	if (Number.isNaN(width)) {
		return DEFAULT_FILE_DOCK_WIDTH;
	}
	return Math.min(MAX_FILE_DOCK_WIDTH, Math.max(MIN_FILE_DOCK_WIDTH, Math.round(width)));
}

export interface UseFileDockResult {
	position: FileDockSide;
	width: number;
	collapsed: boolean;
	dockLeft: () => void;
	dockRight: () => void;
	collapse: () => void;
	expand: () => void;
	setWidth: (width: number) => void;
}

function normalizeWidth(value: unknown): number {
	return typeof value === "number" ? clampFileDockWidth(value) : DEFAULT_FILE_DOCK_WIDTH;
}

export function useFileDock(): UseFileDockResult {
	const [position, setPosition] = useRawLocalStorageValue<FileDockSide>(
		LocalStorageKey.FileDockPosition,
		DEFAULT_FILE_DOCK_SIDE,
		normalizeChatDockSide,
	);
	const [width, setWidthRaw] = useJsonLocalStorageValue<number>(
		LocalStorageKey.FileDockWidth,
		DEFAULT_FILE_DOCK_WIDTH,
		normalizeWidth,
	);
	const [collapsed, setCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.FileDockCollapsed,
		DEFAULT_FILE_DOCK_COLLAPSED,
	);

	const dockLeft = useCallback(() => setPosition("left"), [setPosition]);
	const dockRight = useCallback(() => setPosition("right"), [setPosition]);
	const collapse = useCallback(() => setCollapsed(true), [setCollapsed]);
	const expand = useCallback(() => setCollapsed(false), [setCollapsed]);
	const setWidth = useCallback((next: number) => setWidthRaw(clampFileDockWidth(next)), [setWidthRaw]);

	return useMemo(
		() => ({ position, width, collapsed, dockLeft, dockRight, collapse, expand, setWidth }),
		[position, width, collapsed, dockLeft, dockRight, collapse, expand, setWidth],
	);
}
