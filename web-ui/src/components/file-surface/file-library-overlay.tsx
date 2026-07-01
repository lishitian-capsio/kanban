import * as RadixDialog from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import type React from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { FilesView } from "@/components/files/files-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
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
	/** Open a repo path in the filesystem explorer. */
	onOpenFsPath: (path: string) => void;
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
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
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
					<FileSystemExplorer workspaceId={workspaceId} fsPath={fsPath} onOpenPath={onOpenFsPath} />
				</div>
				<div className={cn("min-h-0 flex-1 flex-col", filesTab === "uploads" ? "flex" : "hidden")}>
					<FilesView workspaceId={workspaceId} />
				</div>
			</div>
		</Dialog>
	);
}
