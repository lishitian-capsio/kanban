import * as Switch from "@radix-ui/react-switch";
import { RefreshCw } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useWindowEvent } from "@/utils/react-use";

import { FileTree } from "./file-tree";
import { FileViewerPane } from "./file-viewer-pane";
import { useFsTree } from "./use-fs-tree";

interface FileSystemExplorerProps {
	workspaceId: string | null;
	/** Currently-open path (mirrors the store's `fsPath`). */
	fsPath: string | null;
	/** Open a file in the right pane (writes the store's `?fsPath`). */
	onOpenPath: (path: string) => void;
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
 * The「文件系统」tab: a VS Code–style, lazily-loaded explorer over the current
 * project's repo working tree (`workspaceFs`). Left = virtualized tree with a
 * "show hidden" toggle + manual/focus refresh; right = read-only viewer. No
 * filesystem watch (design §1) — refresh is manual + on window focus.
 */
export function FileSystemExplorer({ workspaceId, fsPath, onOpenPath }: FileSystemExplorerProps): React.ReactElement {
	const [showHidden, setShowHidden] = useState(false);
	const tree = useFsTree(workspaceId, showHidden);
	const { expandDir, reload } = tree;

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

	const rootLoaded = tree.childrenByDir.has("");
	const rootError = tree.errorByDir.get("");
	const isRootLoading = tree.loadingDirs.has("") && !rootLoaded;

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex w-72 shrink-0 flex-col border-r border-border">
				<div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
					<span className="mr-auto truncate text-[12px] font-medium text-text-secondary">
						{tree.isGitRepository ? "Working tree" : "Files"}
					</span>
					<span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
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
							onSelectFile={onOpenPath}
						/>
					)}
				</div>
			</div>
			<FileViewerPane workspaceId={workspaceId} path={fsPath} />
		</div>
	);
}
