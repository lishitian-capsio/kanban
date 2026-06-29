// Dock controls for the home chat panel header.
//
// A right-aligned cluster of buttons that lives inline on the sidebar header
// row (the project selector carries the "Kanban Agent" identity to its left).
// The cluster is split into two visually separated groups:
//   1. View-mode selector — four mutually-exclusive target states (dock-left,
//      dock-right, float, fullscreen). The button matching the current dock
//      position is highlighted; it reads as a segmented control.
//   2. Window actions — momentary affordances that shrink or dismiss the panel.
//      While docked: collapse (shrink to the edge strip) and hide (remove the
//      panel, reopen from the top bar). While floating: close (return the panel
//      to its last docked side). These trail the selector, with the dismissing
//      "close" X last, mirroring window-chrome convention.
// Fullscreen swaps the compact surface for the Home-tab/session-tab workspace;
// none of the window actions apply there, so that group (and its divider)
// collapses away, leaving just the selector.
//
// The drag-handle (react-rnd) is rendered by the panel, not here, so these
// buttons always stay clickable and never start a window drag.
import {
	Maximize2,
	PanelLeft,
	PanelLeftClose,
	PanelRight,
	PanelRightClose,
	PictureInPicture2,
	X,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";

import type { ChatDockPosition } from "./chat-dock-state";

export const CHAT_DOCK_DRAG_HANDLE_CLASS = "kb-chat-dock-drag-handle";

interface ChatDockControlsProps {
	position: ChatDockPosition;
	// Fullscreen is an orthogonal URL-routed axis (not a dock position): when true the
	// workspace overlays everything regardless of `position` (the restored docked side).
	isFullscreen: boolean;
	onDockLeft: () => void;
	onDockRight: () => void;
	onFloat: () => void;
	onEnterFullscreen: () => void;
	onExitFullscreen: () => void;
	onClose?: () => void;
	onCollapse?: () => void;
	onHide?: () => void;
}

function DockButton({
	active,
	label,
	onClick,
	children,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	children: ReactNode;
}): React.ReactElement {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				aria-label={label}
				aria-pressed={active}
				onClick={onClick}
				className={cn(
					"flex cursor-pointer items-center rounded-sm p-1.5 transition-colors",
					active
						? "bg-surface-4 text-text-primary"
						: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}

export function ChatDockControls({
	position,
	isFullscreen,
	onDockLeft,
	onDockRight,
	onFloat,
	onEnterFullscreen,
	onExitFullscreen,
	onClose,
	onCollapse,
	onHide,
}: ChatDockControlsProps): React.ReactElement {
	const floating = position === "float";
	const fullscreen = isFullscreen;
	// Collapse and hide are docked-only affordances (the edge strip is a docked
	// concept; the float window and the fullscreen workspace own their own chrome).
	const docked = !floating && !fullscreen;
	// Collapse folds the panel toward whichever edge it is docked against.
	const CollapseIcon = position === "left" ? PanelLeftClose : PanelRightClose;

	// Window actions trail the view-mode selector. Collapse (minimize) sits before
	// the dismissing close/hide X so the most destructive control is last.
	const collapseButton =
		docked && onCollapse ? (
			<DockButton active={false} label="Collapse to edge" onClick={onCollapse}>
				<CollapseIcon size={14} />
			</DockButton>
		) : null;
	const closeButton =
		floating && onClose ? (
			<DockButton active={false} label="Close floating window" onClick={onClose}>
				<X size={14} />
			</DockButton>
		) : null;
	const hideButton =
		docked && onHide ? (
			<DockButton active={false} label="Hide panel" onClick={onHide}>
				<X size={14} />
			</DockButton>
		) : null;
	const hasWindowActions = Boolean(collapseButton || closeButton || hideButton);

	return (
		<div className="flex shrink-0 items-center gap-1">
			{/* View-mode selector: mutually-exclusive dock targets, active one highlighted.
			   The dock-position targets (left/right/float) are meaningless in fullscreen —
			   the workspace overlays everything — so they collapse away there, leaving only
			   the fullscreen toggle (which becomes "Exit fullscreen"). */}
			<div className="flex items-center gap-0.5">
				{!fullscreen ? (
					<>
						<DockButton active={position === "left"} label="Dock to left" onClick={onDockLeft}>
							<PanelLeft size={14} />
						</DockButton>
						<DockButton active={position === "right"} label="Dock to right" onClick={onDockRight}>
							<PanelRight size={14} />
						</DockButton>
						<DockButton active={floating} label="Detach as floating window" onClick={onFloat}>
							<PictureInPicture2 size={14} />
						</DockButton>
					</>
				) : null}
				<DockButton
					active={fullscreen}
					label={fullscreen ? "Exit fullscreen" : "Expand to fullscreen workspace"}
					onClick={fullscreen ? onExitFullscreen : onEnterFullscreen}
				>
					<Maximize2 size={14} />
				</DockButton>
			</div>
			{hasWindowActions ? (
				<>
					<div aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
					{/* Window actions: momentary collapse / close / hide affordances. */}
					<div className="flex items-center gap-0.5">
						{collapseButton}
						{closeButton}
						{hideButton}
					</div>
				</>
			) : null}
		</div>
	);
}
