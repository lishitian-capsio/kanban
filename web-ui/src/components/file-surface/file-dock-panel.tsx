// The dockable shell around the File surface's filesystem explorer.
//
// In board mode the File surface is a docked side panel — anchored top-right by
// default and toggleable to the left, mirroring the home chat's Kanban Agent
// sidebar (`DockableChatPanel`). Unlike chat it has no float/fullscreen axis: it
// is left/right + a collapse-to-edge-strip only. Open/close is URL-routed
// (`?files`) in `fileSurfaceStore`; this shell owns placement (side/width/
// collapsed) via `useFileDock` and hosts the unsaved-changes guard the old
// modal overlay carried.
import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Search, X } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { useHorizontalResize } from "@/hooks/use-horizontal-resize";

import { FileSystemExplorer } from "./filesystem/file-system-explorer";
import { FILE_DOCK_COLLAPSED_WIDTH, MAX_FILE_DOCK_WIDTH, MIN_FILE_DOCK_WIDTH, type UseFileDockResult } from "./use-file-dock";

interface FileDockPanelProps {
	dock: UseFileDockResult;
	workspaceId: string | null;
	/** Deep-linked path within the filesystem explorer. */
	fsPath: string | null;
	/** Close (hide) the panel — clears `?files`. */
	onClose: () => void;
	/** Jump to the single-doc quick-open palette without leaving the surface. */
	onOpenPalette: () => void;
	/** Open a repo path in the filesystem explorer (`null` clears the selection). */
	onOpenFsPath: (path: string | null) => void;
}

function DockButton({
	active,
	label,
	onClick,
	children,
}: {
	active?: boolean;
	label: string;
	onClick: () => void;
	children: React.ReactNode;
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

/** The thin edge strip a collapsed panel folds into (one click to expand back). */
function CollapsedFileStrip({ dock, onExpand }: { dock: UseFileDockResult; onExpand: () => void }): React.ReactElement {
	const isLeft = dock.position === "left";
	const ExpandIcon = isLeft ? PanelRight : PanelLeft;
	return (
		<aside
			className={cn(
				"relative flex h-full min-h-0 shrink-0 flex-col bg-surface-1",
				isLeft ? "order-first" : "order-last",
			)}
			style={{
				width: FILE_DOCK_COLLAPSED_WIDTH,
				[isLeft ? "borderRight" : "borderLeft"]: "1px solid var(--color-divider)",
			}}
		>
			<Tooltip content="Expand Files" side={isLeft ? "right" : "left"}>
				<button
					type="button"
					aria-label="Expand Files"
					onClick={onExpand}
					className="flex flex-1 cursor-pointer flex-col items-center gap-2 py-2 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
				>
					<ExpandIcon size={16} className="shrink-0" />
					<span className="text-[11px] font-medium tracking-wide [writing-mode:vertical-rl]">Files</span>
				</button>
			</Tooltip>
		</aside>
	);
}

/**
 * The docked File panel. The unsaved-changes guard mirrors the old modal: the
 * filesystem editor reports its dirty state into `dirtyRef`, and the gestures
 * that would DISCARD an in-progress edit — closing the panel and switching files
 * in the tree — route through `guard`, which confirms via an `AlertDialog`.
 */
export function FileDockPanel({
	dock,
	workspaceId,
	fsPath,
	onClose,
	onOpenPalette,
	onOpenFsPath,
}: FileDockPanelProps): React.ReactElement {
	const isLeft = dock.position === "left";
	const { isResizing, startResize } = useHorizontalResize({
		width: dock.width,
		edge: isLeft ? "right" : "left",
		onWidthChange: dock.setWidth,
	});

	const dirtyRef = useRef(false);
	// The action to run once the user confirms discarding unsaved edits (close /
	// file-switch). Non-null ⇒ the confirm dialog is open.
	const [pendingDiscard, setPendingDiscard] = useState<{ run: () => void } | null>(null);

	const setDirty = useCallback((dirty: boolean) => {
		dirtyRef.current = dirty;
	}, []);

	// Gate a navigation-away action behind the dirty guard: run it immediately when
	// clean, otherwise stash it and open the confirm dialog.
	const guard = useCallback((proceed: () => void) => {
		if (dirtyRef.current) {
			setPendingDiscard({ run: proceed });
			return;
		}
		proceed();
	}, []);

	const confirmDiscard = useCallback(() => {
		const action = pendingDiscard?.run;
		dirtyRef.current = false;
		setPendingDiscard(null);
		action?.();
	}, [pendingDiscard]);

	// ⌘/Ctrl+K jumps to the document quick-open palette. Scoped to the expanded
	// panel so it can't collide with the Vault-scoped ⌘K.
	useHotkeys(
		"mod+k",
		() => onOpenPalette(),
		{ enabled: !dock.collapsed, enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
		[onOpenPalette, dock.collapsed],
	);

	if (dock.collapsed) {
		return <CollapsedFileStrip dock={dock} onExpand={dock.expand} />;
	}

	return (
		<>
			<aside
				className={cn(
					"relative flex h-full min-h-0 shrink-0 flex-col bg-surface-1",
					isLeft ? "order-first" : "order-last",
				)}
				style={{
					width: dock.width,
					minWidth: MIN_FILE_DOCK_WIDTH,
					maxWidth: MAX_FILE_DOCK_WIDTH,
					[isLeft ? "borderRight" : "borderLeft"]: "1px solid var(--color-divider)",
				}}
			>
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize File panel"
					onMouseDown={startResize}
					className={cn(
						"absolute top-0 bottom-0 z-10 w-1.5 cursor-ew-resize",
						isLeft ? "right-0" : "left-0",
						isResizing ? "bg-border-focus/40" : "hover:bg-border-bright/40",
					)}
				/>
				<div className="flex h-full min-h-0 w-full flex-col gap-2 p-2">
					{/* Header: identity left, dock/collapse/close controls right. */}
					<div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
						<span className="mr-auto truncate pl-1.5 text-[13px] font-semibold text-text-primary">Files</span>
						<Button
							variant="ghost"
							size="sm"
							icon={<Search size={14} />}
							onClick={onOpenPalette}
						>
							Open
							<Kbd className="ml-1.5">⌘K</Kbd>
						</Button>
						<div aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
						<div className="flex shrink-0 items-center gap-0.5">
							<DockButton active={isLeft} label="Dock to left" onClick={dock.dockLeft}>
								<PanelLeft size={14} />
							</DockButton>
							<DockButton active={!isLeft} label="Dock to right" onClick={dock.dockRight}>
								<PanelRight size={14} />
							</DockButton>
							<DockButton label="Collapse to edge" onClick={dock.collapse}>
								{isLeft ? <PanelLeftClose size={14} /> : <PanelRightClose size={14} />}
							</DockButton>
							<DockButton label="Close Files" onClick={() => guard(onClose)}>
								<X size={14} />
							</DockButton>
						</div>
					</div>
					<div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-surface-0">
						<FileSystemExplorer
							workspaceId={workspaceId}
							fsPath={fsPath}
							active={!dock.collapsed}
							onOpenPath={onOpenFsPath}
							onDirtyChange={setDirty}
							guardNavigation={guard}
						/>
					</div>
				</div>
			</aside>

			<AlertDialog
				open={pendingDiscard !== null}
				onOpenChange={(next) => (next ? undefined : setPendingDiscard(null))}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						The open file has edits that haven’t been saved. Leaving now will discard them.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setPendingDiscard(null)}>
							Keep editing
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="danger" onClick={confirmDiscard}>
							Discard
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
