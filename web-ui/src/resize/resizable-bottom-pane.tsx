import type { ReactElement, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useUnmount, useWindowEvent } from "@/utils/react-use";

const NAVBAR_HEIGHT_PX = 40;
const COLLAPSE_SCREEN_EDGE_THRESHOLD_PX = 16;

function getDefaultPaneHeight(minHeight: number): number {
	if (typeof window === "undefined") {
		return minHeight;
	}
	const candidate = Math.floor(window.innerHeight * 0.5 - NAVBAR_HEIGHT_PX);
	return Math.max(minHeight, candidate);
}

function getMaxPaneHeight(minHeight: number): number {
	if (typeof window === "undefined") {
		return minHeight;
	}
	return Math.max(minHeight, Math.floor(window.innerHeight - NAVBAR_HEIGHT_PX));
}

function clampHeight(value: number, minHeight: number): number {
	return Math.max(minHeight, Math.min(value, getMaxPaneHeight(minHeight)));
}

// Resolves the persisted (non-fullscreen) pane height. A missing value, or a
// stored height that already fills the screen, falls back to the default so
// that exiting fullscreen always produces a visibly smaller pane. Older builds
// could persist a fullscreen-sized height, which otherwise made collapse a
// no-op.
function resolveStoredPaneHeight(initialHeight: number | undefined, minHeight: number): number {
	if (typeof initialHeight !== "number" || initialHeight >= getMaxPaneHeight(minHeight)) {
		return getDefaultPaneHeight(minHeight);
	}
	return clampHeight(initialHeight, minHeight);
}

function shouldCollapsePane(rawNextHeight: number, minHeight: number, deltaY: number, pointerY: number): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	const hasReachedMinimumHeight = rawNextHeight <= minHeight;
	const isNearBottomScreenEdge = pointerY >= window.innerHeight - COLLAPSE_SCREEN_EDGE_THRESHOLD_PX;
	return deltaY > 0 && hasReachedMinimumHeight && isNearBottomScreenEdge;
}

export function ResizableBottomPane({
	children,
	minHeight = 220,
	initialHeight,
	onHeightChange,
	onCollapse,
	isExpanded,
}: {
	children: ReactNode;
	minHeight?: number;
	initialHeight?: number;
	onHeightChange?: (height: number) => void;
	onCollapse?: () => void;
	isExpanded?: boolean;
}): ReactElement {
	// `height` only ever tracks the collapsed (non-fullscreen) pane height. The
	// fullscreen size is derived from `isExpanded` at render time so it never
	// leaks into the persisted height and cannot get stuck on collapse.
	const [height, setHeight] = useState<number>(() =>
		isExpanded ? getDefaultPaneHeight(minHeight) : resolveStoredPaneHeight(initialHeight, minHeight),
	);
	const [isDragging, setIsDragging] = useState(false);
	const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
	const previousBodyStyleRef = useRef<{ userSelect: string; cursor: string } | null>(null);

	const stopDrag = useCallback(() => {
		setIsDragging(false);
		const previousBodyStyle = previousBodyStyleRef.current;
		if (previousBodyStyle) {
			document.body.style.userSelect = previousBodyStyle.userSelect;
			document.body.style.cursor = previousBodyStyle.cursor;
			previousBodyStyleRef.current = null;
		}
		dragStateRef.current = null;
	}, []);

	useUnmount(() => {
		stopDrag();
	});

	const handleResize = useCallback(() => {
		setHeight((current) => clampHeight(current, minHeight));
	}, [minHeight]);
	useWindowEvent("resize", handleResize);

	useEffect(() => {
		// While expanded the parent feeds a fullscreen sentinel height; ignore it
		// so the stored collapsed height is preserved and restored on collapse.
		if (isExpanded) {
			return;
		}
		setHeight(resolveStoredPaneHeight(initialHeight, minHeight));
	}, [initialHeight, isExpanded, minHeight]);

	// Only a user drag should persist a height. Reporting every internal height
	// change (including the programmatic expand/collapse driven by initialHeight)
	// feeds the temporary fullscreen height back into the shared pane height and
	// oscillates the pane between expanded and collapsed states.
	const handleMouseMove = useCallback(
		(event: MouseEvent) => {
			if (!isDragging) {
				return;
			}
			const dragState = dragStateRef.current;
			if (!dragState) {
				return;
			}
			const deltaY = event.clientY - dragState.startY;
			const rawNextHeight = dragState.startHeight - deltaY;
			if (shouldCollapsePane(rawNextHeight, minHeight, deltaY, event.clientY)) {
				stopDrag();
				onCollapse?.();
				return;
			}
			const nextHeight = clampHeight(dragState.startHeight - deltaY, minHeight);
			setHeight(nextHeight);
			onHeightChange?.(nextHeight);
		},
		[isDragging, minHeight, onCollapse, onHeightChange, stopDrag],
	);

	const handleMouseUp = useCallback(
		(event: MouseEvent) => {
			if (!isDragging) {
				return;
			}
			const dragState = dragStateRef.current;
			if (dragState) {
				const deltaY = event.clientY - dragState.startY;
				const rawNextHeight = dragState.startHeight - deltaY;
				if (shouldCollapsePane(rawNextHeight, minHeight, deltaY, event.clientY)) {
					onCollapse?.();
				}
			}
			stopDrag();
		},
		[isDragging, minHeight, onCollapse, stopDrag],
	);
	useWindowEvent("mousemove", isDragging ? handleMouseMove : null);
	useWindowEvent("mouseup", isDragging ? handleMouseUp : null);

	const handleResizeMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			event.preventDefault();
			// Manual resizing is disabled while expanded; the pane is fullscreen.
			if (isExpanded) {
				return;
			}
			if (isDragging) {
				stopDrag();
			}
			const startY = event.clientY;
			const startHeight = height;
			dragStateRef.current = { startY, startHeight };
			setIsDragging(true);

			previousBodyStyleRef.current = {
				userSelect: document.body.style.userSelect,
				cursor: document.body.style.cursor,
			};
			document.body.style.userSelect = "none";
			document.body.style.cursor = "ns-resize";
		},
		[height, isDragging, isExpanded, stopDrag],
	);

	const isMobile = useIsMobile();

	if (isMobile) {
		return (
			<div
				style={{
					position: "fixed",
					bottom: 0,
					left: 0,
					right: 0,
					height: isExpanded ? "100svh" : "65svh",
					zIndex: 40,
					display: "flex",
					flexDirection: "column",
					borderTop: "1px solid var(--color-divider)",
					background: "var(--color-surface-1)",
					boxShadow: "0 -4px 20px rgba(0,0,0,0.4)",
					animation: "kb-sidebar-slide-up 200ms ease",
				}}
			>
				<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, overflow: "hidden" }}>{children}</div>
			</div>
		);
	}

	const renderedHeight = isExpanded ? getMaxPaneHeight(minHeight) : height;

	return (
		<div
			style={{
				position: "relative",
				display: "flex",
				flex: `0 0 ${renderedHeight}px`,
				minHeight,
				minWidth: 0,
				overflow: "visible",
				borderTop: "1px solid var(--color-divider)",
				background: "var(--color-surface-1)",
			}}
		>
			{isExpanded ? null : (
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label="Resize terminal pane"
					onMouseDown={handleResizeMouseDown}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						height: 10,
						cursor: "ns-resize",
						zIndex: 2,
					}}
				/>
			)}
			<div style={{ display: "flex", flex: "1 1 0", minWidth: 0, overflow: "hidden" }}>{children}</div>
		</div>
	);
}
