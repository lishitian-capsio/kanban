import * as Switch from "@radix-ui/react-switch";
import { FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeFsEntry } from "@/runtime/types";
import { useWindowEvent } from "@/utils/react-use";

import { FileTree } from "./file-tree";
import { FileViewerPane } from "./file-viewer-pane";
import { FsNamePromptDialog } from "./fs-name-prompt-dialog";
import { isPathInside, posixBaseName, posixDirName, posixJoin } from "./fs-path";
import { useFsDownload } from "./use-fs-download";
import { useFsMutations } from "./use-fs-mutations";
import { useFsTree } from "./use-fs-tree";

interface FileSystemExplorerProps {
	workspaceId: string | null;
	/** Currently-open path (mirrors the store's `fsPath`). */
	fsPath: string | null;
	/** Open a path in the right pane, or clear it with `null` (writes `?fsPath`). */
	onOpenPath: (path: string | null) => void;
	/** Report the open file's unsaved-changes state up to the overlay's dirty guard. */
	onDirtyChange: (dirty: boolean) => void;
	/**
	 * Run a navigation-away action through the overlay's unsaved-changes guard.
	 * When the open file is clean it runs immediately; when dirty it prompts first.
	 */
	guardNavigation: (proceed: () => void) => void;
}

/** Repo-relative ancestor directories of a path, root-first: "a/b/c" → ["a","a/b"]. */
function ancestorDirs(path: string): string[] {
	const parts = path.split("/").filter((part) => part.length > 0);
	const ancestors: string[] = [];
	for (let i = 1; i < parts.length; i += 1) {
		ancestors.push(parts.slice(0, i).join("/"));
	}
	return ancestors;
}

/**
 * Remap the currently-open path after `from` was renamed/moved to `to`. Returns
 * the new open path when it (or an ancestor) moved, else `undefined` (no change).
 */
function remapOpenPath(open: string | null, from: string, to: string): string | undefined {
	if (!open) {
		return undefined;
	}
	if (open === from) {
		return to;
	}
	if (open.startsWith(`${from}/`)) {
		return `${to}${open.slice(from.length)}`;
	}
	return undefined;
}

type PromptState =
	| { kind: "create-file" | "create-folder"; parentDir: string }
	| { kind: "rename"; entry: RuntimeFsEntry }
	| null;

/**
 * The「文件系统」tab: a VS Code–style, lazily-loaded explorer over the current
 * project's repo working tree (`workspaceFs`). Left = virtualized tree with a
 * "show hidden" toggle, new file/folder + refresh actions, right-click menu, and
 * drag-to-move; right = read-only viewer. No filesystem watch (design §1) —
 * refresh is manual + on window focus. Mutations refresh only the affected
 * directory layer(s), never the whole tree.
 */
export function FileSystemExplorer({
	workspaceId,
	fsPath,
	onOpenPath,
	onDirtyChange,
	guardNavigation,
}: FileSystemExplorerProps): React.ReactElement {
	const [showHidden, setShowHidden] = useState(false);
	const tree = useFsTree(workspaceId, showHidden);
	const { expandDir, reloadDir, reload } = tree;
	const mutations = useFsMutations(workspaceId);
	const { downloadEntry, isDownloading } = useFsDownload(workspaceId);

	const [prompt, setPrompt] = useState<PromptState>(null);
	const [deleteTarget, setDeleteTarget] = useState<RuntimeFsEntry | null>(null);
	const [deleting, setDeleting] = useState(false);

	// Reveal a deep-linked / newly-opened path by expanding (and loading) its
	// ancestor directories so it becomes visible in the tree.
	useEffect(() => {
		if (!fsPath) {
			return;
		}
		for (const dir of ancestorDirs(fsPath)) {
			expandDir(dir);
		}
	}, [fsPath, expandDir]);

	// No fs.watch in v1: refresh on window focus so external edits show up.
	useWindowEvent(
		"focus",
		useCallback(() => reload(), [reload]),
	);

	// After a mutation, refresh a directory in place and make sure it is visible.
	const refreshDir = useCallback(
		(dir: string) => {
			expandDir(dir);
			reloadDir(dir);
		},
		[expandDir, reloadDir],
	);

	const handleMove = useCallback(
		async (fromPath: string, toDir: string) => {
			const sourceParent = posixDirName(fromPath);
			if (sourceParent === toDir) {
				return; // Already in the target directory.
			}
			if (isPathInside(fromPath, toDir)) {
				notifyError("Cannot move a folder into itself.");
				return;
			}
			const toPath = posixJoin(toDir, posixBaseName(fromPath));
			const result = await mutations.move(fromPath, toPath);
			if (!result.ok) {
				notifyError(result.error ?? "Failed to move.");
				return;
			}
			refreshDir(sourceParent);
			refreshDir(toDir);
			const remapped = remapOpenPath(fsPath, fromPath, toPath);
			if (remapped !== undefined) {
				onOpenPath(remapped);
			}
		},
		[mutations, refreshDir, fsPath, onOpenPath],
	);

	const submitPrompt = useCallback(
		async (name: string): Promise<string | null | undefined> => {
			if (!prompt) {
				return "Nothing to do.";
			}
			if (prompt.kind === "rename") {
				const parent = posixDirName(prompt.entry.path);
				const result = await mutations.rename(prompt.entry.path, name);
				if (!result.ok) {
					return result.error ?? "Failed to rename.";
				}
				const newPath = posixJoin(parent, name);
				refreshDir(parent);
				const remapped = remapOpenPath(fsPath, prompt.entry.path, newPath);
				if (remapped !== undefined) {
					onOpenPath(remapped);
				}
				return null;
			}
			const kind = prompt.kind === "create-folder" ? "dir" : "file";
			const path = posixJoin(prompt.parentDir, name);
			const result = await mutations.createEntry(path, kind);
			if (!result.ok) {
				return result.error ?? "Failed to create.";
			}
			refreshDir(prompt.parentDir);
			if (kind === "file") {
				onOpenPath(path); // Open the freshly-created file.
			}
			return null;
		},
		[prompt, mutations, refreshDir, fsPath, onOpenPath],
	);

	const confirmDelete = useCallback(async () => {
		if (!deleteTarget) {
			return;
		}
		setDeleting(true);
		const parent = posixDirName(deleteTarget.path);
		const result = await mutations.deleteEntry(deleteTarget.path, deleteTarget.kind === "dir");
		setDeleting(false);
		if (!result.ok) {
			notifyError(result.error ?? "Failed to delete.");
			return;
		}
		refreshDir(parent);
		// Clear the viewer when the open file (or its containing folder) is gone.
		if (fsPath && isPathInside(deleteTarget.path, fsPath)) {
			onOpenPath(null);
		}
		setDeleteTarget(null);
	}, [deleteTarget, mutations, refreshDir, fsPath, onOpenPath]);

	const rootLoaded = tree.childrenByDir.has("");
	const rootError = tree.errorByDir.get("");
	const isRootLoading = tree.loadingDirs.has("") && !rootLoaded;

	const promptTitle =
		prompt?.kind === "rename" ? "Rename" : prompt?.kind === "create-folder" ? "New Folder" : "New File";
	const promptInitial = prompt?.kind === "rename" ? prompt.entry.name : "";

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex w-72 shrink-0 flex-col border-r border-border">
				<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
					<span className="mr-auto truncate text-[12px] font-medium text-text-secondary">
						{tree.isGitRepository ? "Working tree" : "Files"}
					</span>
					<span className="flex items-center gap-1.5 pr-1 text-[11px] text-text-tertiary">
						<Switch.Root
							checked={showHidden}
							onCheckedChange={setShowHidden}
							aria-label="Show hidden and ignored items"
							className="relative h-4 w-7 cursor-pointer rounded-full bg-surface-4 outline-none data-[state=checked]:bg-accent"
						>
							<Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3.5" />
						</Switch.Root>
						Hidden
					</span>
					<Tooltip content="New file">
						<Button
							variant="ghost"
							size="sm"
							icon={<FilePlus size={13} />}
							onClick={() => setPrompt({ kind: "create-file", parentDir: "" })}
							aria-label="New file"
						/>
					</Tooltip>
					<Tooltip content="New folder">
						<Button
							variant="ghost"
							size="sm"
							icon={<FolderPlus size={13} />}
							onClick={() => setPrompt({ kind: "create-folder", parentDir: "" })}
							aria-label="New folder"
						/>
					</Tooltip>
					<Tooltip content="Refresh">
						<Button
							variant="ghost"
							size="sm"
							icon={<RefreshCw size={13} />}
							onClick={reload}
							aria-label="Refresh"
						/>
					</Tooltip>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden">
					{isRootLoading ? (
						<div className="flex h-full items-center justify-center">
							<Spinner size={18} />
						</div>
					) : rootError ? (
						<div className="px-3 py-2 text-[12px] text-status-orange">{rootError}</div>
					) : (
						<FileTree
							childrenByDir={tree.childrenByDir}
							expandedDirs={tree.expandedDirs}
							loadingDirs={tree.loadingDirs}
							selectedPath={fsPath}
							onToggleDir={tree.toggleDir}
							onSelectFile={(path) => guardNavigation(() => onOpenPath(path))}
							onRequestCreate={(parentDir, kind) =>
								setPrompt({ kind: kind === "dir" ? "create-folder" : "create-file", parentDir })
							}
							onRequestRename={(entry) => setPrompt({ kind: "rename", entry })}
							onRequestDelete={(entry) => setDeleteTarget(entry)}
							onRequestDownload={(entry) => {
								void downloadEntry(entry.path);
							}}
							onMove={handleMove}
						/>
					)}
				</div>
			</div>
			<FileViewerPane
				workspaceId={workspaceId}
				path={fsPath}
				onDirtyChange={onDirtyChange}
				onDownload={(path) => {
					void downloadEntry(path);
				}}
				isDownloading={isDownloading}
			/>

			{prompt ? (
				<FsNamePromptDialog
					open
					title={promptTitle}
					label={prompt.kind === "rename" ? "New name" : "Name"}
					initialValue={promptInitial}
					submitLabel={prompt.kind === "rename" ? "Rename" : "Create"}
					onSubmit={submitPrompt}
					onClose={() => setPrompt(null)}
				/>
			) : null}

			<AlertDialog open={deleteTarget !== null} onOpenChange={(open) => (open ? undefined : setDeleteTarget(null))}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {deleteTarget?.kind === "dir" ? "folder" : "file"}?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						{deleteTarget?.kind === "dir" ? (
							<>
								<span className="font-medium text-text-primary">{deleteTarget?.name}</span> and everything
								inside it will be permanently deleted from the working tree.
							</>
						) : (
							<>
								<span className="font-medium text-text-primary">{deleteTarget?.name}</span> will be permanently
								deleted from the working tree.
							</>
						)}
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="ghost" size="sm" disabled={deleting}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							size="sm"
							disabled={deleting}
							onClick={(event) => {
								event.preventDefault(); // Keep the dialog open until the delete resolves.
								void confirmDelete();
							}}
						>
							Delete
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
