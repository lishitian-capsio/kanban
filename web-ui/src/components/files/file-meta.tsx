import { File, FileArchive, FileAudio, FileCode, FileText, FileVideo, Image } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type React from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeFileCategory, RuntimeFileItem } from "@/runtime/types";

// Display order for category groups in the file list. Categories with no files are skipped.
export const FILE_CATEGORIES: RuntimeFileCategory[] = [
	"image",
	"document",
	"text",
	"audio",
	"video",
	"archive",
	"other",
];

// Plural headings used for the grouped list sections.
export const CATEGORY_LABELS: Record<RuntimeFileCategory, string> = {
	image: "Images",
	document: "Documents",
	text: "Text",
	audio: "Audio",
	video: "Video",
	archive: "Archives",
	other: "Other",
};

// Singular labels used in the detail panel metadata.
export const CATEGORY_SINGULAR_LABELS: Record<RuntimeFileCategory, string> = {
	image: "Image",
	document: "Document",
	text: "Text",
	audio: "Audio",
	video: "Video",
	archive: "Archive",
	other: "Other",
};

export const CATEGORY_ICON: Record<RuntimeFileCategory, LucideIcon> = {
	image: Image,
	document: FileText,
	text: FileCode,
	audio: FileAudio,
	video: FileVideo,
	archive: FileArchive,
	other: File,
};

// Tailwind text-color class per category, mapped onto the design-system status tokens.
export const CATEGORY_ICON_CLASS: Record<RuntimeFileCategory, string> = {
	image: "text-status-green",
	document: "text-status-blue",
	text: "text-status-purple",
	audio: "text-status-orange",
	video: "text-status-red",
	archive: "text-status-gold",
	other: "text-text-tertiary",
};

export interface FileCategoryGroup {
	category: RuntimeFileCategory;
	label: string;
	files: RuntimeFileItem[];
}

/**
 * Format a byte count into a compact human-readable string (e.g. "1.5 MB").
 * Bytes (exp 0) are shown as whole numbers; larger units keep one decimal.
 */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	const rounded = exponent === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${units[exponent]}`;
}

export function formatAddedAt(timestampMs: number): string {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return "Unknown";
	}
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
		new Date(timestampMs),
	);
}

/**
 * Group files by their manifest category, preserving {@link FILE_CATEGORIES} order and
 * skipping empty categories. Within a group files are sorted newest-first, then by name.
 */
export function groupFilesByCategory(files: RuntimeFileItem[]): FileCategoryGroup[] {
	const byCategory = new Map<RuntimeFileCategory, RuntimeFileItem[]>();
	for (const file of files) {
		const bucket = byCategory.get(file.category);
		if (bucket) {
			bucket.push(file);
		} else {
			byCategory.set(file.category, [file]);
		}
	}
	const groups: FileCategoryGroup[] = [];
	for (const category of FILE_CATEGORIES) {
		const bucket = byCategory.get(category);
		if (!bucket || bucket.length === 0) {
			continue;
		}
		bucket.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
		groups.push({ category, label: CATEGORY_LABELS[category], files: bucket });
	}
	return groups;
}

export function FileCategoryIcon({
	category,
	size = 16,
	className,
}: {
	category: RuntimeFileCategory;
	size?: number;
	className?: string;
}): React.ReactElement {
	const Icon = CATEGORY_ICON[category];
	return <Icon size={size} className={cn(CATEGORY_ICON_CLASS[category], className)} />;
}
