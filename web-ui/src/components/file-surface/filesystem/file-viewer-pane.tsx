import { ChevronRight, FileWarning } from "lucide-react";
import type React from "react";
import { useEffect, useMemo } from "react";

import { formatFileSize } from "@/components/files/file-meta";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeFsReadFileResponse } from "@/runtime/types";

import { FsFileEditor } from "./fs-file-editor";
import { resolveMediaMime, resolveViewerKind } from "./fs-language-map";
import { useFsFile } from "./use-fs-file";

interface FileViewerPaneProps {
	workspaceId: string | null;
	/** Repo-relative POSIX path of the selected file, or null when none is open. */
	path: string | null;
	/** Report the open file's unsaved-changes state so navigation away can be guarded. */
	onDirtyChange: (dirty: boolean) => void;
}

function baseName(path: string): string {
	const segment = path.split("/").pop();
	return segment && segment.length > 0 ? segment : path;
}

function Placeholder({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-text-tertiary">
			{children}
		</div>
	);
}

/**
 * Right pane of the filesystem explorer: a breadcrumb of the open path plus the
 * read-only viewer routed by {@link resolveViewerKind} — markdown via the shared
 * vault preview, text/code via lazy CodeMirror, images/audio/video inline, and a
 * metadata card for oversized or opaque-binary files.
 */
export function FileViewerPane({ workspaceId, path, onDirtyChange }: FileViewerPaneProps): React.ReactElement {
	const { data, isLoading, errorMessage, refetch } = useFsFile(workspaceId, path);

	// A read-only view (no path, loading, error, oversized, or a media/binary file)
	// has no draft, so it can never be dirty — clear any latched flag from a prior
	// editable file that this render is replacing.
	const editable = Boolean(data?.ok && !data.tooLarge && path && !data.binary);
	useEffect(() => {
		if (!editable) {
			onDirtyChange(false);
		}
	}, [editable, onDirtyChange]);

	const segments = useMemo(() => (path ? path.split("/").filter((part) => part.length > 0) : []), [path]);

	const mediaSrc = useMemo(() => {
		if (!data || !data.content || !data.binary || !path) {
			return null;
		}
		const mime = resolveMediaMime(baseName(path));
		return mime ? `data:${mime};base64,${data.content}` : null;
	}, [data, path]);

	if (!path) {
		return <Placeholder>Select a file to view its contents.</Placeholder>;
	}

	const name = baseName(path);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-3 py-2 text-[12px] scrollbar-hidden">
				<nav className="flex items-center gap-0.5 whitespace-nowrap" aria-label="Breadcrumb">
					{segments.map((segment, index) => {
						const isLast = index === segments.length - 1;
						return (
							<span key={`${segment}-${index}`} className="flex items-center gap-0.5">
								{index > 0 ? <ChevronRight size={12} className="text-text-tertiary" /> : null}
								<span className={isLast ? "text-text-primary" : "text-text-secondary"}>{segment}</span>
							</span>
						);
					})}
				</nav>
				{data && !data.tooLarge ? (
					<span className="ml-auto shrink-0 pl-3 text-text-tertiary">{formatFileSize(data.size)}</span>
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				{isLoading ? (
					<div className="flex h-full items-center justify-center">
						<Spinner size={20} />
					</div>
				) : errorMessage ? (
					<Placeholder>
						<FileWarning size={22} className="text-status-orange" />
						<span>{errorMessage}</span>
					</Placeholder>
				) : !data || !data.ok ? (
					<Placeholder>
						<FileWarning size={22} className="text-status-orange" />
						<span>{data?.error ?? "Could not read file."}</span>
					</Placeholder>
				) : data.tooLarge ? (
					<Placeholder>
						<FileWarning size={22} className="text-status-orange" />
						<span>File is too large to preview ({formatFileSize(data.size)}).</span>
						<span className="text-text-tertiary">
							Read-only preview is disabled for files over the size limit.
						</span>
					</Placeholder>
				) : (
					<ViewerBody
						key={path}
						workspaceId={workspaceId}
						path={path}
						name={name}
						data={data}
						mediaSrc={mediaSrc}
						refetch={refetch}
						onDirtyChange={onDirtyChange}
					/>
				)}
			</div>
		</div>
	);
}

function ViewerBody({
	workspaceId,
	path,
	name,
	data,
	mediaSrc,
	refetch,
	onDirtyChange,
}: {
	workspaceId: string | null;
	path: string;
	name: string;
	data: RuntimeFsReadFileResponse;
	mediaSrc: string | null;
	refetch: () => Promise<RuntimeFsReadFileResponse | null>;
	onDirtyChange: (dirty: boolean) => void;
}): React.ReactElement {
	const kind = resolveViewerKind(name, data.binary);
	const content = data.content ?? "";

	// Text/markdown files are editable (design §5.1); the editor owns the draft +
	// save + mtime-conflict handling. FsFileEditor is remounted per path by the
	// `key` on this component, so its buffers reset cleanly when the file switches.
	if (kind === "markdown" || kind === "code") {
		return (
			<FsFileEditor
				workspaceId={workspaceId}
				path={path}
				name={name}
				kind={kind}
				initialContent={content}
				initialMtimeMs={data.mtimeMs}
				refetch={refetch}
				onDirtyChange={onDirtyChange}
			/>
		);
	}
	if (kind === "image" && mediaSrc) {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-surface-1 p-4">
				<img src={mediaSrc} alt={name} className="max-h-full max-w-full object-contain" />
			</div>
		);
	}
	if (kind === "audio" && mediaSrc) {
		return (
			<div className="flex h-full items-center justify-center p-4">
				{/* biome-ignore lint/a11y/useMediaCaption: local working-tree preview, no captions available */}
				<audio src={mediaSrc} controls className="w-full max-w-lg" />
			</div>
		);
	}
	if (kind === "video" && mediaSrc) {
		return (
			<div className="flex h-full items-center justify-center bg-surface-1 p-4">
				{/* biome-ignore lint/a11y/useMediaCaption: local working-tree preview, no captions available */}
				<video src={mediaSrc} controls className="max-h-full max-w-full" />
			</div>
		);
	}
	return (
		<Placeholder>
			<FileWarning size={22} className="text-text-tertiary" />
			<span>This file type cannot be previewed.</span>
		</Placeholder>
	);
}
