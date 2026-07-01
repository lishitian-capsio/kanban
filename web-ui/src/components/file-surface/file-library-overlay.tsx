import * as RadixDialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { FilesView } from "@/components/files/files-view";
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
	Dialog,
} from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import type { FilesSurfaceTab } from "@/hooks/app-utils";

import { FileSystemExplorer } from "./filesystem/file-system-explorer";

interface FileLibraryOverlayProps {
	open: boolean;
	workspaceId: string | null;
	/** Active sub-tab (filesystem explorer vs. upload library). */
	filesTab: FilesSurfaceTab;
	/** Deep-linked path within the filesystem explorer. */
	fsPath: string | null;
	onClose: () => void;
	/** Jump to the single-doc quick-open palette without leaving the surface. */
	onOpenPalette: () => void;
	/** Switch the active sub-tab. */
	onSelectTab: (tab: FilesSurfaceTab) => void;
	/** Open a repo path in the filesystem explorer (`null` clears the selection). */
	onOpenFsPath: (path: string | null) => void;
}

const TABS: { id: FilesSurfaceTab; label: string }[] = [
	{ id: "fs", label: "文件系统" },
	{ id: "uploads", label: "上传" },
];

/**
 * The File surface library overlay, layered above a board that never unmounts
 * (file-surface-migration-design §4). A slim header hosts a two-tab strip:
 *
 * - **文件系统** — a VS Code–style explorer over the current project's repo
 *   working tree (`FileSystemExplorer` + `workspaceFs`). Default tab.
 * - **上传** — the pre-existing binary upload library (`FilesView`, unchanged).
 *
 * Both tabs stay mounted and toggle via CSS `hidden` (never unmount): the tree's
 * expand state and CodeMirror instance are expensive to rebuild, and remounting
 * on every tab switch would flash + lose state. The overlay unmounts wholesale
 * only when `?files` closes.
 *
 * Unsaved-changes guard: the filesystem editor reports its dirty state up into
 * `dirtyRef`, and the two gestures that would DISCARD an in-progress edit —
 * closing the overlay and switching files in the tree — route through `guard`,
 * which confirms via an `AlertDialog` first. Switching sub-tab is NOT guarded:
 * both tabs stay mounted, so the draft survives a tab switch untouched.
 */
export function FileLibraryOverlay({
	open,
	workspaceId,
	filesTab,
	fsPath,
	onClose,
	onOpenPalette,
	onSelectTab,
	onOpenFsPath,
}: FileLibraryOverlayProps): React.ReactElement {
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

	// Scoped to the mounted overlay: ⌘/Ctrl+K jumps to the document quick-open
	// palette. Registered here (not board-wide) so it can't collide with the
	// Vault-scoped ⌘K, which lives inside a separately-mounted VaultView.
	useHotkeys(
		"mod+k",
		() => onOpenPalette(),
		{ enabled: open, enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true },
		[open, onOpenPalette],
	);

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) {
						guard(onClose);
					}
				}}
				contentClassName="!max-w-none !w-[96vw] !h-[94vh] !max-h-[94vh] p-0 overflow-hidden"
			>
				<RadixDialog.Title className="sr-only">Files</RadixDialog.Title>
				<div className="flex flex-1 min-h-0 flex-col">
					<div className="flex items-center gap-2 border-b border-[#5A6572] bg-surface-2 px-3 py-1.5 rounded-t-lg shrink-0">
						<div className="flex items-center gap-1">
							{TABS.map((tab) => (
								<button
									key={tab.id}
									type="button"
									onClick={() => onSelectTab(tab.id)}
									className={cn(
										"rounded-md px-2.5 py-1 text-[13px] font-medium cursor-pointer",
										filesTab === tab.id
											? "bg-surface-3 text-text-primary"
											: "text-text-secondary hover:bg-surface-3/60 hover:text-text-primary",
									)}
								>
									{tab.label}
								</button>
							))}
						</div>
						<Button
							className="ml-auto"
							variant="ghost"
							size="sm"
							icon={<Search size={14} />}
							onClick={onOpenPalette}
						>
							Open document
							<Kbd className="ml-1.5">⌘K</Kbd>
						</Button>
						<RadixDialog.Close
							className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 cursor-pointer"
							aria-label="Close"
						>
							<X size={16} />
						</RadixDialog.Close>
					</div>
					<div className={cn("flex min-h-0 flex-1", filesTab === "fs" ? "flex" : "hidden")}>
						<FileSystemExplorer
							workspaceId={workspaceId}
							fsPath={fsPath}
							active={open && filesTab === "fs"}
							onOpenPath={onOpenFsPath}
							onDirtyChange={setDirty}
							guardNavigation={guard}
						/>
					</div>
					<div className={cn("min-h-0 flex-1 flex-col", filesTab === "uploads" ? "flex" : "hidden")}>
						<FilesView workspaceId={workspaceId} />
					</div>
				</div>
			</Dialog>

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
