// The File surface entry point in the top bar: an icon-only toggle that opens a
// Radix Popover anchored under it, in BOTH board and task (session) modes.
//
// This replaces the old right-docked side panel (`FileDockPanel`). In session
// mode the Kanban Agent already occupies one side, so a second docked edge panel
// sandwiched the content area; a floating popover overlays instead of consuming a
// layout edge. Open/close stays URL-routed (`?files`) via `fileSurfaceStore`, so
// the surface remains shareable, refresh-survivable, and deep-linkable — the
// popover's `open` is bound to that store state.
//
// The heavy filesystem explorer (CodeMirror / `@uiw/react-md-editor`) is lazy so
// it stays out of the entry bundle, but the shell (this file) is eager because
// the trigger must always be present. We preload the explorer chunk on mount so
// the first open is instant ("秒开").
import * as RadixPopover from "@radix-ui/react-popover";
import { FileText, Paperclip, Search, X } from "lucide-react";
import type React from "react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
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

import { fileSurfaceStore } from "./file-surface-store";
import { useFileSurfaceActive, useFileSurfaceLibrary } from "./use-open-file";

// Preloadable lazy import: the same promise both `lazy()` and the mount-time
// preload share, so the chunk is fetched once and cached.
const importFileSystemExplorer = () => import("./filesystem/file-system-explorer");
const FileSystemExplorerLazy = lazy(() =>
	importFileSystemExplorer().then((module) => ({ default: module.FileSystemExplorer })),
);

// The Attachments surface is a secondary tab — lazy without a mount-time preload
// (it shares FileViewerPane / CodeMirror with the explorer chunk anyway).
const AttachmentsBrowserLazy = lazy(() =>
	import("./filesystem/attachments-browser").then((module) => ({ default: module.AttachmentsBrowser })),
);

type FileSurfaceTab = "files" | "attachments";

const MOBILE_TOUCH_TARGET = "min-w-[44px] min-h-[44px]";

interface FilePopoverProps {
	/** Workspace whose files the explorer browses. */
	workspaceId: string | null;
	/** Larger tap target on touch layouts. */
	isMobile?: boolean;
}

/**
 * The File surface toggle + popover. Self-contained: it reads/writes the shared
 * `fileSurfaceStore` directly (no props threaded through the top bar) so opening
 * a file never re-renders `App` or the board.
 */
export function FilePopover({ workspaceId, isMobile = false }: FilePopoverProps): React.ReactElement {
	const isActive = useFileSurfaceActive();
	const { libraryOpen, fsPath } = useFileSurfaceLibrary();
	const [tab, setTab] = useState<FileSurfaceTab>("files");

	// Preload the heavy explorer chunk after mount so the first open is instant.
	useEffect(() => {
		void importFileSystemExplorer();
	}, []);

	// Unsaved-changes guard (mirrors the old docked panel): the explorer reports
	// its dirty state into `dirtyRef`, and gestures that would DISCARD an edit —
	// closing the popover (button / outside-click / Esc) and switching files —
	// route through `guard`, which confirms via an `AlertDialog`.
	const dirtyRef = useRef(false);
	const pendingRef = useRef(false);
	const [pendingDiscard, setPendingDiscard] = useState<{ run: () => void } | null>(null);

	useEffect(() => {
		pendingRef.current = pendingDiscard !== null;
	}, [pendingDiscard]);

	const setDirty = useCallback((dirty: boolean) => {
		dirtyRef.current = dirty;
	}, []);

	const guard = useCallback((proceed: () => void) => {
		if (pendingRef.current) {
			return;
		}
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

	const requestClose = useCallback(() => guard(() => fileSurfaceStore.closeLibrary()), [guard]);

	// Switching tabs unmounts the explorer, so route it through the dirty guard —
	// leaving an unsaved edit prompts to discard first (same as closing the popover).
	const switchTab = useCallback(
		(next: FileSurfaceTab) => {
			if (next === "files") {
				setTab("files");
				return;
			}
			guard(() => setTab(next));
		},
		[guard],
	);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				fileSurfaceStore.openLibrary();
				return;
			}
			requestClose();
		},
		[requestClose],
	);

	// ⌘/Ctrl+K jumps to the document quick-open palette while the Files tab is open.
	useHotkeys(
		"mod+k",
		() => fileSurfaceStore.openPalette(),
		{
			enabled: libraryOpen && tab === "files",
			enableOnFormTags: true,
			enableOnContentEditable: true,
			preventDefault: true,
		},
		[libraryOpen, tab],
	);

	return (
		<RadixPopover.Root open={libraryOpen} onOpenChange={handleOpenChange}>
			<Tooltip side="bottom" content={libraryOpen ? "Hide Files" : "Show Files"}>
				<RadixPopover.Trigger asChild>
					<Button
						variant="ghost"
						size="sm"
						icon={<FileText size={16} />}
						aria-label={libraryOpen ? "Hide Files" : "Show Files"}
						aria-pressed={libraryOpen}
						data-testid="toggle-file-surface-button"
						className={cn(
							"ml-0.5 shrink-0",
							isActive && "bg-surface-3 text-text-primary",
							isMobile && MOBILE_TOUCH_TARGET,
						)}
					/>
				</RadixPopover.Trigger>
			</Tooltip>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="end"
					sideOffset={6}
					collisionPadding={12}
					className="z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-xl"
					// Fixed, responsive dimensions via computed min()/calc() (the old docked
					// panel used inline dimensions too); kb-tooltip-show is the popover fade-in.
					style={{
						width: "min(560px, calc(100vw - 24px))",
						height: "min(640px, 70vh)",
						animation: "kb-tooltip-show 100ms ease",
					}}
				>
					<div className="flex h-full min-h-0 w-full flex-col gap-2 p-2">
						{/* Header: Files / Attachments tabs left, quick-open + close right. */}
						<div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 p-1">
							<div className="mr-auto flex items-center gap-0.5">
								<TabButton
									label="Files"
									icon={<FileText size={13} />}
									selected={tab === "files"}
									onClick={() => switchTab("files")}
								/>
								<TabButton
									label="Attachments"
									icon={<Paperclip size={13} />}
									selected={tab === "attachments"}
									onClick={() => switchTab("attachments")}
								/>
							</div>
							{tab === "files" ? (
								<Button
									variant="ghost"
									size="sm"
									icon={<Search size={14} />}
									onClick={() => fileSurfaceStore.openPalette()}
								>
									Open
									<Kbd className="ml-1.5">⌘K</Kbd>
								</Button>
							) : null}
							<div aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border" />
							<Tooltip content="Close Files">
								<button
									type="button"
									aria-label="Close Files"
									onClick={requestClose}
									className="flex cursor-pointer items-center rounded-sm p-1.5 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
								>
									<X size={14} />
								</button>
							</Tooltip>
						</div>
						<div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-surface-0">
							<Suspense fallback={null}>
								{tab === "files" ? (
									<FileSystemExplorerLazy
										workspaceId={workspaceId}
										fsPath={fsPath}
										active={libraryOpen && tab === "files"}
										onOpenPath={(path) => fileSurfaceStore.openFsPath(path)}
										onDirtyChange={setDirty}
										guardNavigation={guard}
									/>
								) : (
									<AttachmentsBrowserLazy
										workspaceId={workspaceId}
										active={libraryOpen && tab === "attachments"}
									/>
								)}
							</Suspense>
						</div>
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>

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
		</RadixPopover.Root>
	);
}

function TabButton({
	label,
	icon,
	selected,
	onClick,
}: {
	label: string;
	icon: React.ReactNode;
	selected: boolean;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={selected}
			className={cn(
				"flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-[13px] font-semibold transition-colors",
				selected
					? "bg-surface-0 text-text-primary"
					: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
			)}
		>
			{icon}
			{label}
		</button>
	);
}
