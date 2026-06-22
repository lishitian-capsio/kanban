import { Download, FileWarning } from "lucide-react";
import type React from "react";

import { KanbanMarkdownContent } from "@/components/detail-panels/kanban-markdown-content";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeArtifactContentResponse } from "@/runtime/types";

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function ViewerMessage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center text-text-tertiary">
			{icon}
			<h3 className="font-semibold text-text-secondary">{title}</h3>
			{detail ? <p className="max-w-md text-xs text-text-tertiary">{detail}</p> : null}
		</div>
	);
}

/** Inline download link backed by a base64 data URL (self-contained, no file route). */
function DownloadButton({ content }: { content: RuntimeArtifactContentResponse }): React.ReactElement | null {
	if (!content.data) {
		return null;
	}
	const href = `data:${content.mimeType ?? "application/octet-stream"};base64,${content.data}`;
	return (
		<a href={href} download={basename(content.path)} className="no-underline">
			<Button variant="default" size="sm" icon={<Download size={14} />}>
				Download
			</Button>
		</a>
	);
}

/**
 * Read-only viewer for a single artifact. Renders markdown, inline images, and a
 * read-only code view for text/json; binary or oversized files fall back to a
 * path + download affordance. It never mutates the worktree.
 */
export function ArtifactViewer({
	content,
	isLoading,
	isError,
}: {
	content: RuntimeArtifactContentResponse | null;
	isLoading: boolean;
	isError: boolean;
}): React.ReactElement {
	if (isLoading && !content) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner size={20} />
			</div>
		);
	}

	if (isError || !content) {
		return (
			<ViewerMessage icon={<FileWarning size={36} />} title="无法打开产物" detail="该文件可能已被重命名或删除。" />
		);
	}

	if (
		content.truncated &&
		content.previewKind !== "markdown" &&
		content.previewKind !== "text" &&
		content.previewKind !== "json"
	) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<ArtifactPathHeader path={content.path} />
				<ViewerMessage
					icon={<FileWarning size={36} />}
					title="文件过大，无法预览"
					detail="文件超过预览大小上限。"
				/>
			</div>
		);
	}

	if (content.previewKind === "markdown") {
		return (
			<div className="min-h-0 flex-1 overflow-auto px-4 py-3">
				<KanbanMarkdownContent content={content.text ?? ""} />
			</div>
		);
	}

	if (content.previewKind === "image" && content.data) {
		const src = `data:${content.mimeType ?? "image/png"};base64,${content.data}`;
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<ArtifactPathHeader path={content.path} />
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-4">
					<img src={src} alt={basename(content.path)} className="max-h-full max-w-full object-contain" />
				</div>
			</div>
		);
	}

	if (content.previewKind === "text" || content.previewKind === "json") {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<ArtifactPathHeader path={content.path} truncated={content.truncated} />
				<div className="min-h-0 flex-1 overflow-auto bg-surface-0">
					<pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-text-primary">
						{content.text ?? ""}
					</pre>
				</div>
			</div>
		);
	}

	// Binary (pdf, office docs, archives, …): no inline preview, offer download.
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ArtifactPathHeader path={content.path} />
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
				<FileWarning size={36} className="text-text-tertiary" />
				<div className="text-sm text-text-secondary">无法预览此文件类型</div>
				<DownloadButton content={content} />
			</div>
		</div>
	);
}

function ArtifactPathHeader({ path, truncated }: { path: string; truncated?: boolean }): React.ReactElement {
	return (
		<div className="flex items-center gap-2 border-b border-divider px-3 py-1.5">
			<span className="truncate font-mono text-xs text-text-secondary" title={path}>
				{path}
			</span>
			{truncated ? <span className="text-[11px] text-status-orange">（已截断）</span> : null}
		</div>
	);
}
