import { Check, ClipboardCopy, Download, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

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
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeFileItem } from "@/runtime/types";
import { useCopyToClipboard } from "@/utils/react-use";

import { CATEGORY_SINGULAR_LABELS, FileCategoryIcon, formatAddedAt, formatFileSize } from "./file-meta";
import { useFileBytes } from "./use-file-bytes";
import { useFileDownload } from "./use-file-download";

interface FileDetailPanelProps {
	workspaceId: string | null;
	file: RuntimeFileItem;
	onRename: (id: string, name: string) => void;
	onDelete: (id: string) => void;
}

function FilePreview({ workspaceId, file }: { workspaceId: string | null; file: RuntimeFileItem }): React.ReactElement {
	const isPlayable = file.category === "audio" || file.category === "video";
	const wantsBytes = file.category === "image" || isPlayable;
	const { dataUrl, isLoading } = useFileBytes(workspaceId, file.id, wantsBytes);

	if (wantsBytes && isLoading && !dataUrl) {
		return (
			<div className="flex h-64 items-center justify-center">
				<Spinner size={24} />
			</div>
		);
	}

	if (file.category === "image" && dataUrl) {
		return (
			<div className="flex items-center justify-center rounded-lg border border-border bg-surface-2 p-3">
				<img src={dataUrl} alt={file.name} className="max-h-[420px] max-w-full rounded-md object-contain" />
			</div>
		);
	}

	if (file.category === "video" && dataUrl) {
		// biome-ignore lint/a11y/useMediaCaption: user-supplied media without caption tracks.
		return <video src={dataUrl} controls className="max-h-[420px] w-full rounded-lg border border-border bg-black" />;
	}

	if (file.category === "audio" && dataUrl) {
		return (
			<div className="flex items-center justify-center rounded-lg border border-border bg-surface-2 p-6">
				{/* biome-ignore lint/a11y/useMediaCaption: user-supplied media without caption tracks. */}
				<audio src={dataUrl} controls className="w-full" />
			</div>
		);
	}

	return (
		<div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-surface-2 text-text-tertiary">
			<FileCategoryIcon category={file.category} size={48} />
			<span className="text-[12px]">No preview available</span>
		</div>
	);
}

function MetaRow({ label, value }: { label: string; value: string }): React.ReactElement {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{label}</span>
			<span className="break-words text-[13px] text-text-primary">{value}</span>
		</div>
	);
}

export function FileDetailPanel({ workspaceId, file, onRename, onDelete }: FileDetailPanelProps): React.ReactElement {
	const [name, setName] = useState(file.name);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [copiedPath, setCopiedPath] = useState(false);
	const [, copyToClipboard] = useCopyToClipboard();
	const { downloadFile, isDownloading } = useFileDownload(workspaceId);

	// Re-seed the local edit buffer when a different file is selected.
	useEffect(() => {
		setName(file.name);
		setCopiedPath(false);
	}, [file.id, file.name]);

	function commitName(): void {
		const trimmed = name.trim();
		if (!trimmed || trimmed === file.name) {
			setName(file.name);
			return;
		}
		onRename(file.id, trimmed);
	}

	async function handleCopyPath(): Promise<void> {
		if (!workspaceId) {
			return;
		}
		const result = await getRuntimeTrpcClient(workspaceId).workspace.getFilePath.query({ id: file.id });
		if (result.relativePath) {
			copyToClipboard(result.relativePath);
			setCopiedPath(true);
		}
	}

	return (
		<div className="flex flex-1 flex-col overflow-y-auto bg-surface-0">
			<div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					onBlur={commitName}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
					aria-label="File name"
					className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-base font-semibold text-text-primary outline-none hover:border-border focus:border-border-focus focus:bg-surface-2"
				/>
				<div className="flex shrink-0 items-center gap-2">
					<Tooltip content={copiedPath ? "Copied repo path" : "Copy repo-relative path"}>
						<Button
							variant="default"
							size="sm"
							icon={copiedPath ? <Check size={14} /> : <ClipboardCopy size={14} />}
							aria-label="Copy repo-relative path"
							onClick={() => {
								void handleCopyPath();
							}}
						/>
					</Tooltip>
					<Tooltip content="Download file">
						<Button
							variant="default"
							size="sm"
							icon={<Download size={14} />}
							aria-label="Download file"
							disabled={isDownloading}
							onClick={() => {
								void downloadFile(file.id, file.name);
							}}
						/>
					</Tooltip>
					<Button
						variant="danger"
						size="sm"
						icon={<Trash2 size={14} />}
						aria-label="Delete file"
						onClick={() => setIsDeleteOpen(true)}
					/>
				</div>
			</div>

			<div className="px-5 py-4">
				<FilePreview workspaceId={workspaceId} file={file} />
			</div>

			<div className="grid grid-cols-2 gap-4 border-t border-border px-5 py-4">
				<MetaRow label="Type" value={file.mime || "Unknown"} />
				<MetaRow label="Category" value={CATEGORY_SINGULAR_LABELS[file.category]} />
				<MetaRow label="Size" value={formatFileSize(file.size)} />
				<MetaRow label="Added" value={formatAddedAt(file.addedAt)} />
			</div>

			<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete file?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						“{file.name}” will be permanently removed from the file library. This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsDeleteOpen(false)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								setIsDeleteOpen(false);
								onDelete(file.id);
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
