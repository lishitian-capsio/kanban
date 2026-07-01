import * as ContextMenu from "@radix-ui/react-context-menu";
import type { LucideIcon } from "lucide-react";
import {
	ChevronRight,
	Download,
	File,
	FileCode,
	FilePlus,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	Image as ImageIcon,
	Pencil,
	Trash2,
	Upload,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";

import { collectFilesFromDataTransfer } from "@/components/files/file-upload-utils";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeFsEntry } from "@/runtime/types";

import { getLanguageLoader } from "./fs-language-map";

interface FlatRow {
	entry: RuntimeFsEntry;
	depth: number;
}

/** DataTransfer type carrying the dragged entry's repo-relative path. */
const DRAG_MIME = "application/x-kb-fs-path";

/**
 * True when a drag carries OS files (an external upload) rather than an internal
 * entry move. Browsers expose external files as the `"Files"` type on the drag's
 * DataTransfer; our internal drags carry {@link DRAG_MIME} instead.
 */
function dragHasFiles(event: React.DragEvent): boolean {
	return Array.from(event.dataTransfer.types).includes("Files");
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
	/** Request creating a new file/folder inside `parentDir` ("" = root). */
	onRequestCreate: (parentDir: string, kind: "file" | "dir") => void;
	onRequestRename: (entry: RuntimeFsEntry) => void;
	onRequestDelete: (entry: RuntimeFsEntry) => void;
	/** Download an entry: a file directly, a directory as a zip. */
	onRequestDownload: (entry: RuntimeFsEntry) => void;
	/** Move `fromPath` into directory `toDir` ("" = root). */
	onMove: (fromPath: string, toDir: string) => void;
	/** Upload OS files dragged in from outside into directory `toDir` ("" = root). */
	onUploadFiles: (files: File[], toDir: string) => void;
	/** Open the file picker to upload into directory `dir` ("" = root). */
	onRequestUpload: (dir: string) => void;
}

function MenuContent({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<ContextMenu.Portal>
			<ContextMenu.Content className="z-50 min-w-[168px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
				{children}
			</ContextMenu.Content>
		</ContextMenu.Portal>
	);
}

function MenuItem({
	icon,
	label,
	danger,
	onSelect,
}: {
	icon: React.ReactNode;
	label: string;
	danger?: boolean;
	onSelect: () => void;
}): React.ReactElement {
	return (
		<ContextMenu.Item
			onSelect={onSelect}
			className={cn(
				"flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none",
				danger
					? "text-status-red data-[highlighted]:bg-status-red/15"
					: "text-text-secondary data-[highlighted]:bg-surface-3 data-[highlighted]:text-text-primary",
			)}
		>
			{icon}
			{label}
		</ContextMenu.Item>
	);
}

/**
 * Controlled, virtualized working-tree view. It renders exactly the rows implied
 * by `childrenByDir` + `expandedDirs` (no data fetching of its own — the parent's
 * `useFsTree` lazily loads a directory's children on first expand). Each row has
 * a right-click menu (new file/folder, rename, delete) and is draggable; dropping
 * onto a directory (or the empty background = root) requests a move.
 */
export function FileTree({
	childrenByDir,
	expandedDirs,
	loadingDirs,
	selectedPath,
	onToggleDir,
	onSelectFile,
	onRequestCreate,
	onRequestRename,
	onRequestDelete,
	onRequestDownload,
	onMove,
	onUploadFiles,
	onRequestUpload,
}: FileTreeProps): React.ReactElement {
	// The current drop target: null = none, "" = repo root, else a directory path.
	const [dropTarget, setDropTarget] = useState<string | null>(null);

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

	const handleDrop = (event: React.DragEvent, toDir: string): void => {
		// Prevent the browser's default "open the dropped file" navigation.
		event.preventDefault();
		setDropTarget(null);
		// External OS files → upload; must read the DataTransfer synchronously here
		// (browsers clear it after the event dispatch window). Internal drags carry
		// no files and instead expose the dragged entry's path under DRAG_MIME.
		const files = collectFilesFromDataTransfer(event.dataTransfer);
		if (files.length > 0) {
			onUploadFiles(files, toDir);
			return;
		}
		const fromPath = event.dataTransfer.getData(DRAG_MIME);
		if (fromPath) {
			onMove(fromPath, toDir);
		}
	};

	const renderRow = (_index: number, row: FlatRow): React.ReactElement => {
		const { entry, depth } = row;
		const isDir = entry.kind === "dir";
		const isExpanded = isDir && expandedDirs.has(entry.path);
		const isLoading = loadingDirs.has(entry.path);
		const isSelected = entry.path === selectedPath;
		const isDropTarget = isDir && dropTarget === entry.path;
		const FileIconComponent = isDir ? (isExpanded ? FolderOpen : Folder) : iconForFile(entry.name);

		return (
			<ContextMenu.Root>
				<ContextMenu.Trigger asChild>
					<button
						type="button"
						draggable
						onDragStart={(event) => {
							event.dataTransfer.setData(DRAG_MIME, entry.path);
							event.dataTransfer.effectAllowed = "move";
						}}
						onDragOver={
							isDir
								? (event) => {
										event.preventDefault();
										event.stopPropagation();
										event.dataTransfer.dropEffect = dragHasFiles(event) ? "copy" : "move";
										setDropTarget(entry.path);
									}
								: // Files are not drop targets: swallow the event so it neither
									// reaches the root background nor shows a drop cursor.
									(event) => event.stopPropagation()
						}
						onDragLeave={
							isDir ? () => setDropTarget((current) => (current === entry.path ? null : current)) : undefined
						}
						onDrop={isDir ? (event) => handleDrop(event, entry.path) : undefined}
						onClick={() => (isDir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
						title={entry.gitIgnored ? `${entry.path} (git-ignored)` : entry.path}
						className={cn(
							"flex w-full items-center gap-1 py-1 pr-2 text-left text-[13px] cursor-pointer",
							"hover:bg-surface-3",
							isSelected ? "bg-surface-3 text-text-primary" : "text-text-secondary",
							isDropTarget && "bg-accent/20 ring-1 ring-inset ring-accent",
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
				</ContextMenu.Trigger>
				<MenuContent>
					{isDir ? (
						<>
							<MenuItem
								icon={<FilePlus size={14} />}
								label="New File"
								onSelect={() => onRequestCreate(entry.path, "file")}
							/>
							<MenuItem
								icon={<FolderPlus size={14} />}
								label="New Folder"
								onSelect={() => onRequestCreate(entry.path, "dir")}
							/>
							<MenuItem
								icon={<Upload size={14} />}
								label="Upload Files…"
								onSelect={() => onRequestUpload(entry.path)}
							/>
							<ContextMenu.Separator className="my-1 h-px bg-border" />
						</>
					) : null}
					<MenuItem
						icon={<Download size={14} />}
						label={isDir ? "Download as ZIP" : "Download"}
						onSelect={() => onRequestDownload(entry)}
					/>
					<ContextMenu.Separator className="my-1 h-px bg-border" />
					<MenuItem icon={<Pencil size={14} />} label="Rename" onSelect={() => onRequestRename(entry)} />
					<MenuItem icon={<Trash2 size={14} />} label="Delete" danger onSelect={() => onRequestDelete(entry)} />
				</MenuContent>
			</ContextMenu.Root>
		);
	};

	return (
		<div
			className={cn("h-full", dropTarget === "" && "bg-accent/10 ring-1 ring-inset ring-accent/50")}
			onDragOver={(event) => {
				event.preventDefault();
				event.dataTransfer.dropEffect = dragHasFiles(event) ? "copy" : "move";
				setDropTarget("");
			}}
			onDragLeave={(event) => {
				// Only clear when leaving the whole background, not when crossing rows.
				if (event.currentTarget === event.target) {
					setDropTarget((current) => (current === "" ? null : current));
				}
			}}
			onDrop={(event) => handleDrop(event, "")}
		>
			{rows.length === 0 ? (
				<div className="px-3 py-2 text-[12px] text-text-tertiary">Empty.</div>
			) : (
				<Virtuoso data={rows} itemContent={renderRow} className="h-full" />
			)}
		</div>
	);
}
