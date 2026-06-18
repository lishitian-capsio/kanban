// Drag-to-resize for a fixed-width panel column.
//
// `edge` is the side the resize handle sits on: a handle on the panel's "right"
// edge grows the panel as the pointer moves right; a handle on the "left" edge
// grows it as the pointer moves left. Width updates are pushed through
// `onWidthChange` (which is expected to clamp). Mirrors the manual drag pattern
// used by ProjectNavigationPanel.
import { type MouseEvent as ReactMouseEvent, useCallback, useRef, useState } from "react";

import { useUnmount, useWindowEvent } from "@/utils/react-use";

export type HorizontalResizeEdge = "left" | "right";

interface UseHorizontalResizeOptions {
	width: number;
	edge: HorizontalResizeEdge;
	onWidthChange: (next: number) => void;
}

interface UseHorizontalResizeResult {
	isResizing: boolean;
	startResize: (event: ReactMouseEvent) => void;
}

export function useHorizontalResize({
	width,
	edge,
	onWidthChange,
}: UseHorizontalResizeOptions): UseHorizontalResizeResult {
	const [isResizing, setIsResizing] = useState(false);
	const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
	const previousBodyStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);

	const stopResize = useCallback(() => {
		setIsResizing(false);
		const previousStyle = previousBodyStyleRef.current;
		if (previousStyle) {
			document.body.style.userSelect = previousStyle.userSelect;
			document.body.style.cursor = previousStyle.cursor;
			previousBodyStyleRef.current = null;
		}
		dragRef.current = null;
	}, []);

	useUnmount(stopResize);

	const handleMouseMove = useCallback(
		(event: MouseEvent) => {
			const dragState = dragRef.current;
			if (!dragState) {
				return;
			}
			const delta = event.clientX - dragState.startX;
			const signedDelta = edge === "right" ? delta : -delta;
			onWidthChange(dragState.startWidth + signedDelta);
		},
		[edge, onWidthChange],
	);

	const handleMouseUp = useCallback(() => {
		if (isResizing) {
			stopResize();
		}
	}, [isResizing, stopResize]);

	useWindowEvent("mousemove", isResizing ? handleMouseMove : null);
	useWindowEvent("mouseup", isResizing ? handleMouseUp : null);

	const startResize = useCallback(
		(event: ReactMouseEvent) => {
			event.preventDefault();
			dragRef.current = { startX: event.clientX, startWidth: width };
			setIsResizing(true);
			previousBodyStyleRef.current = {
				userSelect: document.body.style.userSelect,
				cursor: document.body.style.cursor,
			};
			document.body.style.userSelect = "none";
			document.body.style.cursor = "ew-resize";
		},
		[width],
	);

	return { isResizing, startResize };
}
