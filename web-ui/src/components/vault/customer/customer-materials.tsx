import { Paperclip, Upload, X } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useRef } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { formatFileSize } from "@/components/files/file-meta";
import { FileThumbnail } from "@/components/files/file-thumbnail";
import { useFileLibrary } from "@/components/files/use-file-library";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface CustomerMaterialsProps {
	workspaceId: string | null;
	/** File-library ids pinned to this customer. */
	materialIds: string[];
	onChange: (ids: string[]) => void;
}

/**
 * Files attached to a customer ("客户材料挂其名下"). Materials are ids into the shared
 * binary file library — uploading adds to the library and pins the new id here;
 * detaching only unlinks (the file stays in the library). Thumbnails/preview reuse
 * the file-library components.
 */
export function CustomerMaterials({ workspaceId, materialIds, onChange }: CustomerMaterialsProps): React.ReactElement {
	const { files, isLoading, uploadFiles, isMutating } = useFileLibrary(workspaceId);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const materials = useMemo(() => {
		const byId = new Map(files.map((file) => [file.id, file]));
		return materialIds.map((id) => byId.get(id)).filter((file): file is NonNullable<typeof file> => Boolean(file));
	}, [files, materialIds]);

	// Pinned ids whose file is gone from the library (deleted there) — surfaced so a
	// stale reference can be cleaned up rather than silently lingering in frontmatter.
	const missingCount = materialIds.length - materials.length;

	const handleUpload = useCallback(
		async (incoming: File[]) => {
			if (incoming.length === 0) {
				return;
			}
			try {
				const result = await uploadFiles(incoming);
				if (result.added.length > 0) {
					const addedIds = result.added.map((file) => file.id);
					onChange([...materialIds, ...addedIds.filter((id) => !materialIds.includes(id))]);
					showAppToast(
						{
							intent: "success",
							icon: "tick",
							message:
								result.added.length === 1
									? `Attached “${result.added[0]?.name}”.`
									: `Attached ${result.added.length} files.`,
							timeout: 3000,
						},
						"customer-material-attached",
					);
				}
				if (result.skipped.length > 0) {
					notifyError(`Skipped ${result.skipped.length} file(s) that were too large or unreadable.`, {
						key: "customer-material-skipped",
					});
				}
			} catch (error) {
				notifyError(error instanceof Error ? error.message : "Upload failed.", { key: "customer-material-error" });
			}
		},
		[uploadFiles, onChange, materialIds],
	);

	function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>): void {
		const picked = event.target.files ? Array.from(event.target.files) : [];
		void handleUpload(picked);
		event.target.value = "";
	}

	function detach(id: string): void {
		onChange(materialIds.filter((materialId) => materialId !== id));
	}

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
					<Paperclip size={13} />
					Materials
					<span className="font-normal normal-case text-text-tertiary">{materials.length}</span>
				</div>
				<div className="ml-auto flex items-center gap-2">
					{isMutating ? <Spinner size={14} /> : null}
					<input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
					<Button
						variant="default"
						size="sm"
						icon={<Upload size={14} />}
						disabled={!workspaceId || isMutating}
						onClick={() => fileInputRef.current?.click()}
					>
						Attach
					</Button>
				</div>
			</div>

			{materials.length === 0 ? (
				<p className="text-[13px] text-text-tertiary">
					{isLoading ? "Loading…" : "No materials attached. Click Attach to add supporting files."}
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{materials.map((file) => (
						<li
							key={file.id}
							className="flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-2 py-1.5"
						>
							<FileThumbnail workspaceId={workspaceId} file={file} size={32} />
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-[13px] text-text-primary">{file.name}</span>
								<span className="text-[11px] text-text-tertiary">{formatFileSize(file.size)}</span>
							</div>
							<button
								type="button"
								aria-label={`Detach ${file.name}`}
								onClick={() => detach(file.id)}
								className="shrink-0 rounded-sm p-1 text-text-tertiary outline-none hover:bg-surface-4 hover:text-text-primary"
							>
								<X size={14} />
							</button>
						</li>
					))}
				</ul>
			)}

			{missingCount > 0 ? (
				<button
					type="button"
					onClick={() => onChange(materials.map((file) => file.id))}
					className="self-start text-[12px] text-status-orange underline-offset-2 hover:underline"
				>
					Remove {missingCount} link{missingCount === 1 ? "" : "s"} to deleted file
					{missingCount === 1 ? "" : "s"}
				</button>
			) : null}
		</section>
	);
}
