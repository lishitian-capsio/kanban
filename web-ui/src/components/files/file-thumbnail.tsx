import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeFileItem } from "@/runtime/types";

import { FileCategoryIcon } from "./file-meta";
import { useFileBytes } from "./use-file-bytes";

// Only fetch and decode inline thumbnails for reasonably small images; larger ones fall back
// to the category icon to avoid base64-decoding multi-megabyte blobs in the list.
const MAX_THUMBNAIL_SIZE_BYTES = 8 * 1024 * 1024;

interface FileThumbnailProps {
	workspaceId: string | null;
	file: RuntimeFileItem;
	size: number;
	className?: string;
}

export function FileThumbnail({ workspaceId, file, size, className }: FileThumbnailProps): React.ReactElement {
	const wantsThumbnail = file.category === "image" && file.size <= MAX_THUMBNAIL_SIZE_BYTES;
	const { dataUrl } = useFileBytes(workspaceId, file.id, wantsThumbnail);

	const frameClassName = cn(
		"flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2",
		className,
	);

	if (wantsThumbnail && dataUrl) {
		return (
			<div className={frameClassName} style={{ width: size, height: size }}>
				<img src={dataUrl} alt={file.name} className="h-full w-full object-cover" />
			</div>
		);
	}

	return (
		<div className={frameClassName} style={{ width: size, height: size }}>
			<FileCategoryIcon category={file.category} size={Math.round(size * 0.5)} />
		</div>
	);
}
