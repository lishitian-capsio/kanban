// The dockable shell around the home chat surface.
//
// Reuses the existing chat element (passed as `children`) and places it
// according to the persisted dock position:
//   - left / right: a resizable flex column. Left↔right only flips the CSS
//     `order`, so the chat session is not remounted when swapping sides.
//   - float: a free-floating, draggable, resizable window (react-rnd) inside a
//     full-screen pointer-events-none overlay so the rest of the app stays
//     interactive. z-40 keeps it below Radix dialogs/dropdowns (z-50).
import { Rnd } from "react-rnd";

import { cn } from "@/components/ui/cn";
import type { UseChatDockResult } from "@/hooks/use-chat-dock";
import { useHorizontalResize } from "@/hooks/use-horizontal-resize";

import { CHAT_DOCK_DRAG_HANDLE_CLASS, ChatDockHeader } from "./chat-dock-header";
import {
	MAX_CHAT_DOCK_WIDTH,
	MIN_CHAT_DOCK_WIDTH,
	MIN_CHAT_FLOAT_HEIGHT,
	MIN_CHAT_FLOAT_WIDTH,
} from "./chat-dock-state";

interface DockableChatPanelProps {
	dock: UseChatDockResult;
	children: React.ReactNode;
}

function DockHeaderWithChildren({ dock, children }: DockableChatPanelProps): React.ReactElement {
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2 p-2">
			<ChatDockHeader
				position={dock.position}
				onDockLeft={dock.dockLeft}
				onDockRight={dock.dockRight}
				onFloat={dock.floatPanel}
				onClose={dock.closeFloat}
			/>
			<div className="flex min-h-0 flex-1 [&>*]:w-full [&>*]:self-stretch">{children}</div>
		</div>
	);
}

export function DockableChatPanel({ dock, children }: DockableChatPanelProps): React.ReactElement {
	const isLeft = dock.position === "left";
	const { isResizing, startResize } = useHorizontalResize({
		width: dock.width,
		edge: isLeft ? "right" : "left",
		onWidthChange: dock.setWidth,
	});

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
						<DockHeaderWithChildren dock={dock}>{children}</DockHeaderWithChildren>
					</div>
				</Rnd>
			</div>
		);
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
			<DockHeaderWithChildren dock={dock}>{children}</DockHeaderWithChildren>
		</aside>
	);
}
