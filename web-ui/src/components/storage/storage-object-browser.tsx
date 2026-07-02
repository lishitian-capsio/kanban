import { ChevronRight, File, FileCode, FileText, Folder, Image as ImageIcon, RefreshCw } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeStorageEntry } from "@/runtime/types";
import type { useStorageTree } from "./use-storage-tree";

export interface StorageObjectBrowserProps {
	tree: ReturnType<typeof useStorageTree>;
	selectedKey: string | null;
	onSelectKey: (key: string) => void;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
const TEXT_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt"]);

function iconForObject(name: string): React.ReactElement {
	const dot = name.lastIndexOf(".");
	const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		return <ImageIcon size={14} className="text-text-tertiary shrink-0" />;
	}
	if (TEXT_EXTENSIONS.has(ext)) {
		return <FileText size={14} className="text-text-tertiary shrink-0" />;
	}
	if (ext.length > 0) {
		return <FileCode size={14} className="text-text-tertiary shrink-0" />;
	}
	return <File size={14} className="text-text-tertiary shrink-0" />;
}

function formatBytes(size: number): string {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
	} catch {
		return iso;
	}
}

/** Build the breadcrumb segments from a prefix string. */
function parseBreadcrumbs(prefix: string): Array<{ label: string; prefixUpTo: string }> {
	if (!prefix) {
		return [{ label: "Root", prefixUpTo: "" }];
	}
	// prefix is like "folder/" or "a/b/c/"
	const parts = prefix.replace(/\/$/, "").split("/");
	const crumbs: Array<{ label: string; prefixUpTo: string }> = [{ label: "Root", prefixUpTo: "" }];
	let cumulative = "";
	for (const part of parts) {
		cumulative += `${part}/`;
		crumbs.push({ label: part, prefixUpTo: cumulative });
	}
	return crumbs;
}

export function StorageObjectBrowser({ tree, selectedKey, onSelectKey }: StorageObjectBrowserProps): React.ReactElement {
	const { prefix, entries, isTruncated, isLoading, errorMessage, enter, loadMore, reload } = tree;
	const breadcrumbs = parseBreadcrumbs(prefix);

	return (
		<div className="flex flex-col min-h-0 flex-1 bg-surface-0">
			{/* Breadcrumb */}
			<div className="flex items-center gap-0.5 px-3 py-2 border-b border-border bg-surface-1 shrink-0 overflow-x-auto">
				{breadcrumbs.map((crumb, index) => (
					<span key={crumb.prefixUpTo} className="flex items-center gap-0.5 shrink-0">
						{index > 0 ? <ChevronRight size={12} className="text-text-tertiary" /> : null}
						<button
							type="button"
							onClick={() => enter(crumb.prefixUpTo)}
							className={cn(
								"text-[12px] px-1 py-0.5 rounded hover:bg-surface-2",
								index === breadcrumbs.length - 1 ? "text-text-primary font-medium" : "text-text-secondary",
							)}
						>
							{crumb.label}
						</button>
					</span>
				))}
				<div className="ml-auto flex items-center shrink-0">
					<Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={reload} title="Reload" />
				</div>
			</div>

			{/* Error banner */}
			{errorMessage ? (
				<div className="px-3 py-2 text-[12px] text-status-red border-b border-border bg-surface-1 shrink-0">
					{errorMessage}
				</div>
			) : null}

			{/* Entry list */}
			<div className="flex-1 overflow-y-auto overscroll-contain min-h-0">
				{isLoading && entries.length === 0 ? (
					<div className="flex items-center gap-2 px-3 py-4 text-[12px] text-text-tertiary">
						<Spinner size={12} /> Loading objects…
					</div>
				) : null}
				{!isLoading && entries.length === 0 && !errorMessage ? (
					<div className="px-3 py-6 text-center text-[12px] text-text-tertiary">This prefix is empty.</div>
				) : null}
				{entries.map((entry) => (
					<EntryRow
						key={entry.key}
						entry={entry}
						isSelected={selectedKey === entry.key}
						onSelect={() => {
							if (entry.kind === "prefix") {
								enter(entry.key);
							} else {
								onSelectKey(entry.key);
							}
						}}
						onDoubleClick={() => {
							if (entry.kind === "prefix") {
								enter(entry.key);
							}
						}}
					/>
				))}
				{isTruncated ? (
					<div className="px-3 py-2 border-t border-border">
						<Button variant="default" size="sm" onClick={loadMore} disabled={isLoading}>
							{isLoading ? <Spinner size={12} /> : null}
							Load more
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}

function EntryRow({
	entry,
	isSelected,
	onSelect,
	onDoubleClick,
}: {
	entry: RuntimeStorageEntry;
	isSelected: boolean;
	onSelect: () => void;
	onDoubleClick: () => void;
}): React.ReactElement {
	const isPrefix = entry.kind === "prefix";
	return (
		<div
			className={cn(
				"group flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-border/50 last:border-b-0",
				isSelected ? "bg-surface-2" : "hover:bg-surface-2",
			)}
			onClick={onSelect}
			onDoubleClick={onDoubleClick}
		>
			{isPrefix ? (
				<Folder size={14} className="text-status-orange shrink-0" />
			) : (
				iconForObject(entry.name)
			)}
			<span className="flex-1 truncate text-[13px] text-text-primary">{entry.name}</span>
			{!isPrefix && entry.size != null ? (
				<span className="text-[11px] text-text-tertiary shrink-0">{formatBytes(entry.size)}</span>
			) : null}
			{!isPrefix && entry.lastModified ? (
				<span className="text-[11px] text-text-tertiary shrink-0">{formatDate(entry.lastModified)}</span>
			) : null}
		</div>
	);
}
