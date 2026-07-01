import { FileText, Search } from "lucide-react";
import type React from "react";
import { useCallback } from "react";

import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import { posixBaseName, posixDirName } from "./fs-path";
import { useFsQuickOpen } from "./use-fs-quick-open";

interface FsQuickOpenProps {
	open: boolean;
	workspaceId: string | null;
	/** Open the chosen repo-relative path in the explorer's right pane. */
	onOpenPath: (path: string) => void;
	onClose: () => void;
}

/**
 * VS Code–style Quick Open (⌘P) for the「文件系统」tab: fuzzy-find a working-tree
 * file by path and open it in the right pane. Reuses the interaction/keybinding
 * frame of the document quick-open palette ({@link FileQuickOpen}) — a focused
 * `Dialog` with ArrowUp/Down + Enter — but sources a flat, capped path index
 * (`workspaceFs.listPaths`) and matches it client-side with fzf
 * ({@link useFsQuickOpen}). Distinct from the document palette (⌘K, vault docs by
 * id); this is scoped to the filesystem tab and opens repo paths.
 *
 * Mounted only while open (the explorer gates it), so its fetch + fzf index are
 * created on open and discarded on close.
 */
export function FsQuickOpen({ open, workspaceId, onOpenPath, onClose }: FsQuickOpenProps): React.ReactElement {
	const { query, setQuery, results, isLoading, truncated, selectedIndex, setSelectedIndex } = useFsQuickOpen(
		workspaceId,
		open,
	);

	const clampedIndex = results.length === 0 ? 0 : Math.min(selectedIndex, results.length - 1);

	const select = useCallback(
		(path: string) => {
			onOpenPath(path);
			onClose();
		},
		[onOpenPath, onClose],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelectedIndex(results.length === 0 ? 0 : (clampedIndex + 1) % results.length);
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelectedIndex(results.length === 0 ? 0 : (clampedIndex - 1 + results.length) % results.length);
			} else if (event.key === "Enter") {
				event.preventDefault();
				const path = results[clampedIndex];
				if (path) {
					select(path);
				}
			}
		},
		[results, clampedIndex, setSelectedIndex, select],
	);

	const isEmptyQuery = query.trim().length === 0;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			contentClassName="max-w-xl w-[90vw] p-0 overflow-hidden"
		>
			<div className="flex items-center gap-2 border-b border-[#5A6572] bg-surface-2 px-3 py-2.5">
				<Search size={16} className="shrink-0 text-text-tertiary" />
				{/* A command palette focuses its input on open. */}
				<input
					autoFocus
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setSelectedIndex(0);
					}}
					onKeyDown={handleKeyDown}
					placeholder="Go to file by path…"
					aria-label="Go to file"
					className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
				/>
				{isLoading ? <Spinner size={14} /> : null}
			</div>

			<div className="max-h-[50vh] overflow-y-auto overscroll-contain bg-surface-1 p-1">
				{results.length === 0 ? (
					<div className="px-3 py-6 text-center text-[13px] text-text-tertiary">
						{isLoading
							? "Loading files…"
							: isEmptyQuery
								? "No files in this working tree."
								: "No files match your search."}
					</div>
				) : (
					results.map((path, index) => {
						const name = posixBaseName(path);
						const dir = posixDirName(path);
						return (
							<button
								key={path}
								type="button"
								onClick={() => select(path)}
								onMouseEnter={() => setSelectedIndex(index)}
								className={cn(
									"flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
									index === clampedIndex ? "bg-surface-3" : "hover:bg-surface-2",
								)}
							>
								<span className="shrink-0 text-text-tertiary">
									<FileText size={15} />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] font-medium text-text-primary">{name}</span>
									{dir ? <span className="block truncate text-xs text-text-tertiary">{dir}</span> : null}
								</span>
							</button>
						);
					})
				)}
			</div>

			{truncated ? (
				<div className="border-t border-border bg-surface-1 px-3 py-1.5 text-center text-[11px] text-text-tertiary">
					结果已截断——仓库文件过多,请输入更精确的路径缩小范围。
				</div>
			) : null}
		</Dialog>
	);
}
