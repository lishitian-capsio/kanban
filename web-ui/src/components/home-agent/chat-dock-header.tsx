// Dock controls for the home chat panel header.
//
// A right-aligned cluster of buttons that lives inline on the sidebar header
// row (the project selector carries the "Kanban Agent" identity to its left).
// Four independent target-state buttons (no cycle): dock-left, dock-right,
// float, fullscreen. The button matching the current dock position is
// highlighted. While docked, two extra controls appear: collapse (shrink to the
// edge strip) and hide (remove the panel, reopen from the top bar). In the
// floating state an extra close button returns the panel to its last docked
// side. Fullscreen swaps the compact surface for the Home-tab/session-tab
// workspace; collapse/hide are docked-only and so are suppressed there.
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
	const fullscreen = position === "fullscreen";
	// Collapse and hide are docked-only affordances (the edge strip is a docked
	// concept; the float window and the fullscreen workspace own their own chrome).
	const docked = !floating && !fullscreen;
	// Collapse folds the panel toward whichever edge it is docked against.
	const CollapseIcon = position === "left" ? PanelLeftClose : PanelRightClose;
	return (
		<div className="flex shrink-0 items-center gap-0.5">
			{docked && onCollapse ? (
				<DockButton active={false} label="Collapse to edge" onClick={onCollapse}>
					<CollapseIcon size={14} />
				</DockButton>
			) : null}
			<DockButton active={position === "left"} label="Dock to left" onClick={onDockLeft}>
				<PanelLeft size={14} />
			</DockButton>
			<DockButton active={position === "right"} label="Dock to right" onClick={onDockRight}>
				<PanelRight size={14} />
			</DockButton>
			<DockButton active={floating} label="Detach as floating window" onClick={onFloat}>
				<PictureInPicture2 size={14} />
			</DockButton>
			<DockButton
				active={fullscreen}
				label={fullscreen ? "Exit fullscreen" : "Expand to fullscreen workspace"}
				onClick={fullscreen ? onExitFullscreen : onEnterFullscreen}
			>
				<Maximize2 size={14} />
			</DockButton>
			{floating && onClose ? (
				<DockButton active={false} label="Close floating window" onClick={onClose}>
					<X size={14} />
				</DockButton>
			) : null}
			{docked && onHide ? (
				<DockButton active={false} label="Hide panel" onClick={onHide}>
					<X size={14} />
				</DockButton>
			) : null}
		</div>
	);
}
