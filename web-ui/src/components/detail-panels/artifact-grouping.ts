import type { RuntimeArtifact, RuntimeArtifactPreviewKind } from "@/runtime/types";

export interface ArtifactGroup {
	type: string;
	label: string;
	artifacts: RuntimeArtifact[];
}

/**
 * Group artifacts by their `type` for the sectioned list. The incoming list is
 * already sorted by label then path (backend `detectArtifacts`), so groups and
 * their members preserve that order. "Other" is pushed to the end.
 */
export function groupArtifactsByType(artifacts: RuntimeArtifact[]): ArtifactGroup[] {
	const groups = new Map<string, ArtifactGroup>();
	for (const artifact of artifacts) {
		const existing = groups.get(artifact.type);
		if (existing) {
			existing.artifacts.push(artifact);
		} else {
			groups.set(artifact.type, { type: artifact.type, label: artifact.label, artifacts: [artifact] });
		}
	}
	return Array.from(groups.values()).sort((left, right) => {
		if (left.type === "other") {
			return 1;
		}
		if (right.type === "other") {
			return -1;
		}
		return left.label.localeCompare(right.label);
	});
}

/** Coarse icon bucket for an artifact, derived from its preview kind + type. */
export type ArtifactIconKind = "markdown" | "image" | "json" | "table" | "text" | "binary";

export function resolveArtifactIconKind(artifact: Pick<RuntimeArtifact, "previewKind" | "path">): ArtifactIconKind {
	const previewKind: RuntimeArtifactPreviewKind = artifact.previewKind;
	if (previewKind === "image") {
		return "image";
	}
	if (previewKind === "json") {
		return "json";
	}
	if (previewKind === "binary") {
		return "binary";
	}
	if (previewKind === "markdown") {
		return "markdown";
	}
	// text: distinguish tabular data from plain text by extension.
	const lower = artifact.path.toLowerCase();
	if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
		return "table";
	}
	return "text";
}
