import { Download, MessagesSquare, Paperclip, RefreshCw, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import { formatAddedAt, formatFileSize } from "@/components/files/file-meta";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
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
import type { RuntimeWorkspaceAttachmentFile, RuntimeWorkspaceAttachmentScope } from "@/runtime/types";

import { FileViewerPane } from "./file-viewer-pane";
import { useFsDownload } from "./use-fs-download";
import { useWorkspaceAttachments } from "./use-workspace-attachments";

interface AttachmentsBrowserProps {
	workspaceId: string | null;
	/** Whether this surface is currently visible (drives the initial load). */
	active: boolean;
}

/** A pending delete confirmation: one file, or a whole session's attachments. */
type DeleteTarget =
	| { kind: "file"; scopeId: string; file: RuntimeWorkspaceAttachmentFile }
	| { kind: "scope"; scope: RuntimeWorkspaceAttachmentScope };

/** Human label for a session scope: its thread name, else a short raw id. */
function scopeLabel(scope: RuntimeWorkspaceAttachmentScope): string {
	if (scope.name && scope.name.trim().length > 0) {
		return scope.name;
	}
	return scope.isDefaultThread ? "Home" : scope.scopeId;
}

/**
 * The "Attachments" surface inside the File popover: every uploaded chat attachment,
 * grouped by session (home thread), with per-file preview / download / delete and a
 * per-session "delete all". This is a controlled window into `.kanban/attachments/`
 * — the general file explorer keeps all of `.kanban` hidden; only this dedicated,
 * path-safe API exposes attachments. Preview + download reuse the working-tree read
 * path (the listing returns repo-relative `.kanban/...` paths).
 */
export function AttachmentsBrowser({ workspaceId, active }: AttachmentsBrowserProps): React.ReactElement {
	const { scopes, isLoading, errorMessage, reload, deleteFile, deleteScope } = useWorkspaceAttachments(
		workspaceId,
		active,
	);
	const { downloadEntry, isDownloading } = useFsDownload(workspaceId);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
	const [deleting, setDeleting] = useState(false);

	// If the selected file disappears (deleted, or a reload dropped it), clear the pane.
	useEffect(() => {
		if (!selectedPath) {
			return;
		}
		const stillPresent = scopes.some((scope) => scope.files.some((file) => file.path === selectedPath));
		if (!stillPresent) {
			setSelectedPath(null);
		}
	}, [scopes, selectedPath]);

	const confirmDelete = useCallback(async () => {
		if (!deleteTarget) {
			return;
		}
		setDeleting(true);
		const ok =
			deleteTarget.kind === "file"
				? await deleteFile(deleteTarget.scopeId, deleteTarget.file.fileName)
				: await deleteScope(deleteTarget.scope.scopeId);
		setDeleting(false);
		if (!ok) {
			notifyError(errorMessage ?? "Could not delete the attachment.");
			return;
		}
		setDeleteTarget(null);
	}, [deleteTarget, deleteFile, deleteScope, errorMessage]);

	const isEmpty = !isLoading && scopes.length === 0;

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex w-72 shrink-0 flex-col border-r border-border">
				<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
					<Paperclip size={13} className="ml-0.5 text-text-tertiary" />
					<span className="mr-auto truncate pl-1 text-[12px] font-medium text-text-secondary">
						Chat attachments
					</span>
					<Tooltip content="Refresh">
						<Button
							variant="ghost"
							size="sm"
							icon={<RefreshCw size={13} />}
							onClick={() => void reload()}
							aria-label="Refresh attachments"
						/>
					</Tooltip>
				</div>
				<div className="min-h-0 flex-1 overflow-auto">
					{isLoading ? (
						<div className="flex h-full items-center justify-center">
							<Spinner size={18} />
						</div>
					) : errorMessage && scopes.length === 0 ? (
						<div className="px-3 py-2 text-[12px] text-status-orange">{errorMessage}</div>
					) : isEmpty ? (
						<div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-[12px] text-text-tertiary">
							<Paperclip size={20} />
							<span>No chat attachments yet.</span>
							<span>Files dropped or pasted into a chat appear here, grouped by session.</span>
						</div>
					) : (
						scopes.map((scope) => (
							<AttachmentScopeGroup
								key={scope.scopeId}
								scope={scope}
								selectedPath={selectedPath}
								onSelect={setSelectedPath}
								onDownload={(path) => void downloadEntry(path)}
								onDeleteFile={(file) => setDeleteTarget({ kind: "file", scopeId: scope.scopeId, file })}
								onDeleteScope={() => setDeleteTarget({ kind: "scope", scope })}
							/>
						))
					)}
				</div>
			</div>
			<FileViewerPane
				workspaceId={workspaceId}
				path={selectedPath}
				onDirtyChange={() => undefined}
				onDownload={(path) => void downloadEntry(path)}
				isDownloading={isDownloading}
				readOnly
			/>

			<AlertDialog open={deleteTarget !== null} onOpenChange={(open) => (open ? undefined : setDeleteTarget(null))}>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{deleteTarget?.kind === "scope" ? "Delete all attachments?" : "Delete attachment?"}
					</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						{deleteTarget?.kind === "scope" ? (
							<>
								All <span className="font-medium text-text-primary">{deleteTarget.scope.files.length}</span>{" "}
								attachment(s) for{" "}
								<span className="font-medium text-text-primary">{scopeLabel(deleteTarget.scope)}</span> will be
								permanently deleted from disk.
							</>
						) : deleteTarget ? (
							<>
								<span className="font-medium text-text-primary">{deleteTarget.file.fileName}</span> will be
								permanently deleted from disk.
							</>
						) : null}
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

function AttachmentScopeGroup({
	scope,
	selectedPath,
	onSelect,
	onDownload,
	onDeleteFile,
	onDeleteScope,
}: {
	scope: RuntimeWorkspaceAttachmentScope;
	selectedPath: string | null;
	onSelect: (path: string) => void;
	onDownload: (path: string) => void;
	onDeleteFile: (file: RuntimeWorkspaceAttachmentFile) => void;
	onDeleteScope: () => void;
}): React.ReactElement {
	return (
		<div className="border-b border-border/60 last:border-b-0">
			<div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface-1/95 px-2.5 py-1.5 backdrop-blur">
				<MessagesSquare size={12} className="shrink-0 text-text-tertiary" />
				<span className="mr-auto truncate text-[12px] font-medium text-text-secondary" title={scope.scopeId}>
					{scopeLabel(scope)}
				</span>
				<span className="shrink-0 text-[11px] text-text-tertiary">{scope.files.length}</span>
				<Tooltip content="Delete all in this session">
					<Button
						variant="ghost"
						size="sm"
						icon={<Trash2 size={12} />}
						onClick={onDeleteScope}
						aria-label={`Delete all attachments for ${scopeLabel(scope)}`}
					/>
				</Tooltip>
			</div>
			<ul>
				{scope.files.map((file) => {
					const isSelected = file.path === selectedPath;
					return (
						<li key={file.path}>
							<div
								className={cn(
									"group flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-surface-2",
									isSelected && "bg-surface-2",
								)}
							>
								<button
									type="button"
									onClick={() => onSelect(file.path)}
									className="flex min-w-0 flex-1 flex-col items-start text-left"
								>
									<span
										className={cn(
											"max-w-full truncate text-[12px]",
											isSelected ? "text-text-primary" : "text-text-secondary",
										)}
									>
										{file.fileName}
									</span>
									<span className="text-[10.5px] text-text-tertiary">
										{formatFileSize(file.size)} · {formatAddedAt(file.mtimeMs)}
									</span>
								</button>
								<div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
									<Tooltip content="Download">
										<Button
											variant="ghost"
											size="sm"
											icon={<Download size={12} />}
											onClick={() => onDownload(file.path)}
											aria-label={`Download ${file.fileName}`}
										/>
									</Tooltip>
									<Tooltip content="Delete">
										<Button
											variant="ghost"
											size="sm"
											icon={<Trash2 size={12} />}
											onClick={() => onDeleteFile(file)}
											aria-label={`Delete ${file.fileName}`}
										/>
									</Tooltip>
								</div>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
