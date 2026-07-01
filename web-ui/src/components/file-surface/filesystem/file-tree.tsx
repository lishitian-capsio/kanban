import type { LucideIcon } from "lucide-react";
import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, Image as ImageIcon } from "lucide-react";
import type React from "react";
import { useMemo } from "react";
import { Virtuoso } from "react-virtuoso";

import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeFsEntry } from "@/runtime/types";

import { getLanguageLoader } from "./fs-language-map";

interface FlatRow {
	entry: RuntimeFsEntry;
	depth: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);

function iconForFile(name: string): LucideIcon {
	const dot = name.lastIndexOf(".");
	const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		return ImageIcon;
	}
	if (ext === "md" || ext === "markdown" || ext === "mdx" || ext === "txt") {
		return FileText;
	}
	if (getLanguageLoader(name)) {
		return FileCode;
	}
	return File;
}

interface FileTreeProps {
	childrenByDir: Map<string, RuntimeFsEntry[]>;
	expandedDirs: Set<string>;
	loadingDirs: Set<string>;
	selectedPath: string | null;
	onToggleDir: (path: string) => void;
	onSelectFile: (path: string) => void;
}

/**
 * Controlled, virtualized working-tree view. It renders exactly the rows implied
 * by `childrenByDir` + `expandedDirs` (no data fetching of its own — the parent's
 * `useFsTree` lazily loads a directory's children on first expand).
 */
export function FileTree({
	childrenByDir,
	expandedDirs,
	loadingDirs,
	selectedPath,
	onToggleDir,
	onSelectFile,
}: FileTreeProps): React.ReactElement {
	const rows = useMemo(() => {
		const flat: FlatRow[] = [];
		const walk = (dir: string, depth: number): void => {
			const entries = childrenByDir.get(dir);
			if (!entries) {
				return;
			}
			for (const entry of entries) {
				flat.push({ entry, depth });
				if (entry.kind === "dir" && expandedDirs.has(entry.path)) {
					walk(entry.path, depth + 1);
				}
			}
		};
		walk("", 0);
		return flat;
	}, [childrenByDir, expandedDirs]);

	const renderRow = (_index: number, row: FlatRow): React.ReactElement => {
		const { entry, depth } = row;
		const isDir = entry.kind === "dir";
		const isExpanded = isDir && expandedDirs.has(entry.path);
		const isLoading = loadingDirs.has(entry.path);
		const isSelected = entry.path === selectedPath;
		const FileIconComponent = isDir ? (isExpanded ? FolderOpen : Folder) : iconForFile(entry.name);

		return (
			<button
				type="button"
				onClick={() => (isDir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
				title={entry.gitIgnored ? `${entry.path} (git-ignored)` : entry.path}
				className={cn(
					"flex w-full items-center gap-1 py-1 pr-2 text-left text-[13px] cursor-pointer",
					"hover:bg-surface-3",
					isSelected ? "bg-surface-3 text-text-primary" : "text-text-secondary",
					entry.gitIgnored && "opacity-60",
				)}
				style={{ paddingLeft: `${depth * 14 + 8}px` }}
			>
				<span className="flex h-4 w-4 shrink-0 items-center justify-center">
					{isDir ? (
						isLoading ? (
							<Spinner size={12} />
						) : (
							<ChevronRight
								size={14}
								className={cn("text-text-tertiary transition-transform", isExpanded && "rotate-90")}
							/>
						)
					) : null}
				</span>
				<FileIconComponent
					size={15}
					className={cn("shrink-0", isDir ? "text-status-blue" : "text-text-tertiary")}
				/>
				<span className="truncate">{entry.name}</span>
				{entry.isSymlink ? <span className="shrink-0 text-[10px] text-text-tertiary">↳</span> : null}
			</button>
		);
	};

	if (rows.length === 0) {
		return <div className="px-3 py-2 text-[12px] text-text-tertiary">Empty.</div>;
	}

	return <Virtuoso data={rows} itemContent={renderRow} className="h-full" />;
}
