import type React from "react";
import { useMemo } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeFileItem } from "@/runtime/types";

import { formatFileSize, groupFilesByCategory } from "./file-meta";
import { FileThumbnail } from "./file-thumbnail";

interface FileListProps {
	workspaceId: string | null;
	files: RuntimeFileItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}

export function FileList({ workspaceId, files, selectedId, onSelect }: FileListProps): React.ReactElement {
	const groups = useMemo(() => groupFilesByCategory(files), [files]);

	if (files.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center px-4 py-12 text-center text-[13px] text-text-tertiary">
				No files yet. Drag files here or use Upload.
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-y-auto">
			{groups.map((group) => (
				<div key={group.category} className="flex flex-col">
					<div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-1 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
						<span>{group.label}</span>
						<span className="text-text-tertiary/70">{group.files.length}</span>
					</div>
					{group.files.map((file) => {
						const isSelected = file.id === selectedId;
						return (
							<button
								key={file.id}
								type="button"
								onClick={() => onSelect(file.id)}
								className={cn(
									"flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left outline-none",
									isSelected ? "bg-surface-3" : "hover:bg-surface-2",
								)}
							>
								<FileThumbnail workspaceId={workspaceId} file={file} size={36} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span
										className={cn(
											"truncate text-[13px]",
											isSelected ? "text-text-primary" : "text-text-secondary",
										)}
									>
										{file.name}
									</span>
									<span className="truncate text-[11px] text-text-tertiary">
										{formatFileSize(file.size)} · {file.mime || "unknown type"}
									</span>
								</div>
							</button>
						);
					})}
				</div>
			))}
		</div>
	);
}
