// The dockable shell around the home chat surface.
//
// The `isFullscreen` prop (an orthogonal URL-routed axis, see
// use-fullscreen-chat-navigation) chooses what to mount: the compact surface
// (`children`) for docked/float, or the fullscreen workspace (`fullscreenContent`)
// when fullscreen. The shell then places that content according to the persisted
// dock position:
//   - left / right: a resizable flex column. Left↔right only flips the CSS
//     `order`, so the chat session is not remounted when swapping sides.
//   - float: a free-floating, draggable, resizable window (react-rnd) inside a
//     full-screen pointer-events-none overlay so the rest of the app stays
//     interactive. z-40 keeps it below Radix dialogs/dropdowns (z-50).
//   - fullscreen: a solid full-viewport overlay (same z-40) carrying the header
//     and the fullscreen workspace. Same data, a roomier presentation.
// When docked and `collapsed`, the chat is replaced by a thin edge strip whose
// only job is a one-click expand back to the previous width and side. The fully
// hidden (`open === false`) state is handled by the caller, which simply stops
// rendering this component (reopen lives in the top bar).
//
// This is the single unified "cockpit" sidebar: the header is ONE row — the
// `projectSwitcher` slot (carrying the "Kanban Agent" identity) grows on the
// left while the dock controls sit right-aligned beside it — and a fixed bottom
// ops status-bar seam travels with the panel. Both are inside
// `DockHeaderWithChildren`, so they follow the panel when docked/floated and
// disappear when it collapses to the edge strip — by construction.
import { GripVertical, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { Rnd } from "react-rnd";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { UseChatDockResult } from "@/hooks/use-chat-dock";
import { useHorizontalResize } from "@/hooks/use-horizontal-resize";

import { CHAT_DOCK_DRAG_HANDLE_CLASS, ChatDockControls } from "./chat-dock-header";
import {
	CHAT_DOCK_COLLAPSED_WIDTH,
	MAX_CHAT_DOCK_WIDTH,
	MIN_CHAT_DOCK_WIDTH,
	MIN_CHAT_FLOAT_HEIGHT,
	MIN_CHAT_FLOAT_WIDTH,
} from "./chat-dock-state";
import { SidebarOpsStatusBar } from "./sidebar-ops-status-bar";

interface DockableChatPanelProps {
	dock: UseChatDockResult;
	// Fullscreen is an orthogonal URL-routed axis (see use-fullscreen-chat-navigation):
	// when true, the workspace overlays everything regardless of the docked `position`.
	isFullscreen: boolean;
	onEnterFullscreen: () => void;
	onExitFullscreen: () => void;
	// Project navigation, folded into the sidebar header (the old standalone
	// `ProjectNavigationPanel` column). Rendered just below the dock controls.
	projectSwitcher?: React.ReactNode;
	// The fullscreen-state presentation (Home tab + session tabs). Mounted only
	// when fullscreen; `children` is the compact surface for docked/float.
	fullscreenContent?: React.ReactNode;
	children: React.ReactNode;
}

function DockHeaderWithChildren({
	dock,
	isFullscreen,
	onEnterFullscreen,
	onExitFullscreen,
	projectSwitcher,
	children,
}: Omit<DockableChatPanelProps, "fullscreenContent">): React.ReactElement {
	const floating = dock.position === "float";
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2 p-2">
			{/* Single header row: project selector (with "Kanban Agent" identity) left, dock controls right. */}
			<div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
				{floating ? (
					<div
						className={cn(
							CHAT_DOCK_DRAG_HANDLE_CLASS,
							"flex shrink-0 cursor-move items-center px-0.5 text-text-secondary",
						)}
						aria-hidden="true"
					>
						<GripVertical size={14} className="shrink-0" />
					</div>
				) : null}
				{projectSwitcher}
				<ChatDockControls
					position={dock.position}
					isFullscreen={isFullscreen}
					onDockLeft={dock.dockLeft}
					onDockRight={dock.dockRight}
					onFloat={dock.floatPanel}
					onEnterFullscreen={onEnterFullscreen}
					onExitFullscreen={onExitFullscreen}
					onClose={dock.closeFloat}
					onCollapse={dock.collapse}
					onHide={dock.hide}
				/>
			</div>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">{children}</div>
			<SidebarOpsStatusBar />
		</div>
	);
}

function CollapsedChatStrip({ dock }: { dock: UseChatDockResult }): React.ReactElement {
	const isLeft = dock.position === "left";
	const ExpandIcon = isLeft ? PanelRightOpen : PanelLeftOpen;
	return (
		<aside
			className={cn("relative flex h-full min-h-0 shrink-0 flex-col bg-surface-1", isLeft ? "order-1" : "order-3")}
			style={{
				width: CHAT_DOCK_COLLAPSED_WIDTH,
				[isLeft ? "borderRight" : "borderLeft"]: "1px solid var(--color-divider)",
			}}
		>
			<Tooltip content="Expand Kanban Agent" side={isLeft ? "right" : "left"}>
				<button
					type="button"
					aria-label="Expand Kanban Agent"
					onClick={dock.expand}
					className="flex flex-1 cursor-pointer flex-col items-center gap-2 py-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
				>
					<ExpandIcon size={16} className="shrink-0" />
					<span className="text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">Kanban Agent</span>
				</button>
			</Tooltip>
		</aside>
	);
}

export function DockableChatPanel({
	dock,
	isFullscreen,
	onEnterFullscreen,
	onExitFullscreen,
	projectSwitcher,
	fullscreenContent,
	children,
}: DockableChatPanelProps): React.ReactElement {
	const isLeft = dock.position === "left";
	const { isResizing, startResize } = useHorizontalResize({
		width: dock.width,
		edge: isLeft ? "right" : "left",
		onWidthChange: dock.setWidth,
	});
	const headerProps = { dock, isFullscreen, onEnterFullscreen, onExitFullscreen, projectSwitcher };

	// Fullscreen owns the whole viewport: a solid overlay carrying the same header
	// (so the dock/exit controls stay reachable) with the workspace presentation
	// in place of the compact surface.
	if (isFullscreen) {
		return (
			<div className="fixed inset-0 z-40 flex flex-col bg-surface-0">
				<DockHeaderWithChildren {...headerProps}>{fullscreenContent}</DockHeaderWithChildren>
			</div>
		);
	}

	if (dock.position === "float") {
		const { floatRect } = dock;
		return (
			<div className="pointer-events-none fixed inset-0 z-40">
				<Rnd
					className="pointer-events-auto"
					bounds="parent"
					dragHandleClassName={CHAT_DOCK_DRAG_HANDLE_CLASS}
					minWidth={MIN_CHAT_FLOAT_WIDTH}
					minHeight={MIN_CHAT_FLOAT_HEIGHT}
					size={{ width: floatRect.width, height: floatRect.height }}
					position={{ x: floatRect.x, y: floatRect.y }}
					onDragStop={(_event, data) => {
						dock.setFloatRect({ ...floatRect, x: data.x, y: data.y });
					}}
					onResizeStop={(_event, _direction, elementRef, _delta, position) => {
						dock.setFloatRect({
							x: position.x,
							y: position.y,
							width: elementRef.offsetWidth,
							height: elementRef.offsetHeight,
						});
					}}
				>
					<div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
						<DockHeaderWithChildren {...headerProps}>{children}</DockHeaderWithChildren>
					</div>
				</Rnd>
			</div>
		);
	}

	if (dock.collapsed) {
		return <CollapsedChatStrip dock={dock} />;
	}

	return (
		<aside
			className={cn("relative flex h-full min-h-0 shrink-0 flex-col bg-surface-1", isLeft ? "order-1" : "order-3")}
			style={{
				width: dock.width,
				minWidth: MIN_CHAT_DOCK_WIDTH,
				maxWidth: MAX_CHAT_DOCK_WIDTH,
				[isLeft ? "borderRight" : "borderLeft"]: "1px solid var(--color-divider)",
			}}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize chat panel"
				onMouseDown={startResize}
				className={cn(
					"absolute top-0 bottom-0 z-10 w-1.5 cursor-ew-resize",
					isLeft ? "right-0" : "left-0",
					isResizing ? "bg-border-focus/40" : "hover:bg-border-bright/40",
				)}
			/>
			<DockHeaderWithChildren {...headerProps}>{children}</DockHeaderWithChildren>
		</aside>
	);
}
