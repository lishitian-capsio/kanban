import { Files, Upload } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useDropArea } from "@/utils/react-use";

import { FileDetailPanel } from "./file-detail-panel";
import { FileList } from "./file-list";
import { useFileLibrary } from "./use-file-library";

interface FilesViewProps {
	workspaceId: string | null;
}

export function FilesView({ workspaceId }: FilesViewProps): React.ReactElement {
	const { files, isLoading, errorMessage, uploadFiles, renameFile, deleteFile, isMutating } =
		useFileLibrary(workspaceId);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const selected = useMemo(() => files.find((file) => file.id === selectedId) ?? null, [files, selectedId]);

	const handleUpload = useCallback(
		async (incoming: File[]) => {
			if (incoming.length === 0) {
				return;
			}
			try {
				const result = await uploadFiles(incoming);
				const firstAdded = result.added[0];
				if (firstAdded) {
					setSelectedId(firstAdded.id);
					showAppToast(
						{
							intent: "success",
							icon: "tick",
							message:
								result.added.length === 1
									? `Added “${firstAdded.name}”.`
									: `Added ${result.added.length} files.`,
							timeout: 3000,
						},
						"file-upload-success",
					);
				}
				if (result.skipped.length > 0) {
					notifyError(`Skipped ${result.skipped.length} file(s) that were too large or unreadable.`, {
						key: "file-upload-skipped",
					});
				}
			} catch (error) {
				notifyError(error instanceof Error ? error.message : "Upload failed.", { key: "file-upload-error" });
			}
		},
		[uploadFiles],
	);

	const [dropBond, dropState] = useDropArea({
		onFiles: (dropped) => {
			void handleUpload(dropped);
		},
	});

	const handleRename = useCallback(
		(id: string, name: string) => {
			void renameFile(id, name);
		},
		[renameFile],
	);

	const handleDelete = useCallback(
		(id: string) => {
			void (async () => {
				const removed = await deleteFile(id);
				if (removed && selectedId === id) {
					setSelectedId(null);
				}
			})();
		},
		[deleteFile, selectedId],
	);

	function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
		const picked = event.target.files ? Array.from(event.target.files) : [];
		void handleUpload(picked);
		// Reset so selecting the same file again re-triggers the change event.
		event.target.value = "";
	}

	if (!workspaceId) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-0 py-12 text-text-tertiary">
				<Files size={48} />
				<h3 className="font-semibold text-text-primary">No project selected</h3>
				<p className="text-[13px]">Select a project to manage its files.</p>
			</div>
		);
	}

	return (
		<div className="relative flex flex-1 flex-col bg-surface-0" {...dropBond}>
			<div className="flex items-center gap-3 border-b border-border bg-surface-1 px-5 py-3">
				<div className="flex items-center gap-2 text-text-primary">
					<Files size={16} />
					<h2 className="text-sm font-semibold">Files</h2>
					<span className="text-[12px] text-text-tertiary">{files.length}</span>
				</div>
				<div className="ml-auto flex items-center gap-2">
					{isMutating ? <Spinner size={14} /> : null}
					<input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
					<Button
						variant="primary"
						size="sm"
						icon={<Upload size={14} />}
						onClick={() => fileInputRef.current?.click()}
					>
						Upload
					</Button>
				</div>
			</div>

			<div className="flex flex-1 min-h-0">
				<div className={cn("flex w-80 shrink-0 flex-col border-r border-border", "min-h-0")}>
					{isLoading && files.length === 0 ? (
						<div className="flex flex-1 items-center justify-center">
							<Spinner size={24} />
						</div>
					) : errorMessage && files.length === 0 ? (
						<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-status-red">
							{errorMessage}
						</div>
					) : (
						<FileList
							workspaceId={workspaceId}
							files={files}
							selectedId={selectedId}
							onSelect={setSelectedId}
						/>
					)}
				</div>
				{selected ? (
					<FileDetailPanel
						workspaceId={workspaceId}
						file={selected}
						onRename={handleRename}
						onDelete={handleDelete}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center bg-surface-0 px-4 text-center text-[13px] text-text-tertiary">
						{files.length === 0
							? "Drag files here or click Upload to add your first file."
							: "Select a file to preview and manage it."}
					</div>
				)}
			</div>

			{dropState.over ? (
				<div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
					<div className="flex flex-col items-center gap-2 text-accent">
						<Upload size={32} />
						<span className="text-sm font-semibold">Drop files to upload</span>
					</div>
				</div>
			) : null}
		</div>
	);
}
