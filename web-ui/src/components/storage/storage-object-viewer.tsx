import { Download } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { CodeEditorLazy } from "@/components/file-surface/filesystem/code-editor-lazy";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { downloadBase64 } from "@/utils/download";
import { createLogger } from "@/utils/logger";
import type { useStorageObject } from "./use-storage-object";

const log = createLogger("storage:viewer");

const IMAGE_CONTENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
	"image/avif",
	"image/x-icon",
]);

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
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function fileNameFromKey(key: string): string {
	const slash = key.lastIndexOf("/");
	return slash === -1 ? key : key.slice(slash + 1);
}

export interface StorageObjectViewerProps {
	workspaceId: string;
	connId: string;
	objectQuery: ReturnType<typeof useStorageObject>;
}

export function StorageObjectViewer({ workspaceId, connId, objectQuery }: StorageObjectViewerProps): React.ReactElement {
	const { content, isLoading, errorMessage } = objectQuery;
	const [isDownloading, setIsDownloading] = useState(false);

	const handleDownload = useCallback(async () => {
		if (!content) {
			return;
		}
		setIsDownloading(true);
		try {
			const result = await getRuntimeTrpcClient(workspaceId).storage.downloadObject.query({
				connId,
				key: content.key,
			});
			if (result.tooLarge || !result.data) {
				notifyError("Object is too large to download.");
				return;
			}
			const fileName = fileNameFromKey(content.key);
			downloadBase64(fileName, result.data, result.contentType);
			showAppToast({ intent: "success", icon: "download", message: `Downloading "${fileName}".`, timeout: 2500 });
		} catch (error) {
			log.error("Failed to download object", { key: content.key, error });
			notifyError("Could not download the object.");
		} finally {
			setIsDownloading(false);
		}
	}, [workspaceId, connId, content]);

	if (isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 text-[12px] text-text-tertiary gap-2">
				<Spinner size={16} /> Loading…
			</div>
		);
	}

	if (errorMessage) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 px-4">
				<span className="text-[13px] text-status-red text-center">{errorMessage}</span>
			</div>
		);
	}

	if (!content) {
		return <div className="flex flex-1 bg-surface-0" />;
	}

	const fileName = fileNameFromKey(content.key);
	const isImage = IMAGE_CONTENT_TYPES.has(content.contentType);

	return (
		<div className="flex flex-col min-h-0 flex-1 bg-surface-0">
			{/* Stat strip */}
			<div className="flex items-center gap-4 px-3 py-2 border-b border-border bg-surface-1 shrink-0 flex-wrap">
				<span className="text-[12px] font-medium text-text-primary truncate max-w-xs" title={content.key}>
					{fileName}
				</span>
				<span className="text-[11px] text-text-tertiary">{formatBytes(content.size)}</span>
				<span className="text-[11px] text-text-tertiary">{formatDate(content.lastModified)}</span>
				<span className="text-[11px] text-text-tertiary">{content.contentType}</span>
				{content.etag ? (
					<span className="text-[11px] text-text-tertiary font-mono" title="ETag">{content.etag}</span>
				) : null}
				<div className="ml-auto shrink-0">
					<Button
						variant="ghost"
						size="sm"
						icon={isDownloading ? <Spinner size={13} /> : <Download size={13} />}
						disabled={isDownloading}
						onClick={() => void handleDownload()}
					>
						Download
					</Button>
				</div>
			</div>

			{/* Preview area */}
			<div className="flex-1 min-h-0 overflow-auto">
				{content.tooLarge ? (
					<div className="flex flex-col items-center justify-center h-full gap-3 text-text-tertiary">
						<span className="text-[13px]">Too large to preview</span>
						<Button
							variant="primary"
							size="sm"
							icon={isDownloading ? <Spinner size={13} /> : <Download size={13} />}
							disabled={isDownloading}
							onClick={() => void handleDownload()}
						>
							Download
						</Button>
					</div>
				) : isImage && content.content ? (
					<div className="flex items-center justify-center h-full p-4">
						<img
							src={`data:${content.contentType};base64,${content.content}`}
							alt={fileName}
							className="max-w-full max-h-full object-contain"
						/>
					</div>
				) : !content.binary && content.content !== null ? (
					<div className="h-full">
						<CodeEditorLazy
							value={content.content ?? ""}
							fileName={fileName}
							editable={false}
						/>
					</div>
				) : (
					<div className="flex flex-col items-center justify-center h-full gap-3 text-text-tertiary">
						<span className="text-[13px]">Binary file — no preview available</span>
						<Button
							variant="default"
							size="sm"
							icon={isDownloading ? <Spinner size={13} /> : <Download size={13} />}
							disabled={isDownloading}
							onClick={() => void handleDownload()}
						>
							Download
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
