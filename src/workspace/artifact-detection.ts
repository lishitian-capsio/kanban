import type {
	RuntimeArtifact,
	RuntimeArtifactPreviewKind,
	RuntimeArtifactStatus,
	RuntimeWorkspaceFileStatus,
} from "../core/api-contract";

/**
 * One changed path observed in a task worktree (git name-status + untracked).
 * Only the path and coarse status are needed — artifact detection is a pure
 * path/extension observation with zero plugin cooperation.
 */
export interface ArtifactChangeInput {
	path: string;
	status: RuntimeWorkspaceFileStatus;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);
const JSON_EXTENSIONS = new Set([".json", ".json5", ".jsonc", ".geojson"]);
const TEXT_EXTENSIONS = new Set([".csv", ".tsv", ".txt", ".log", ".yaml", ".yml", ".xml", ".html", ".htm", ".rst"]);
const BINARY_DOC_EXTENSIONS = new Set([
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".odt",
	".ods",
	".odp",
	".zip",
]);

/** Human-friendly labels for the well-known vault / convention type slugs. */
const KNOWN_TYPE_LABELS: Record<string, string> = {
	plan: "Plan",
	spec: "Spec",
	report: "Report",
	requirement: "Requirement",
	customer: "Customer",
	decision: "Decision",
	note: "Note",
};

function getExtension(path: string): string {
	const base = path.split("/").pop() ?? path;
	const dotIndex = base.lastIndexOf(".");
	if (dotIndex <= 0) {
		return "";
	}
	return base.slice(dotIndex).toLowerCase();
}

/**
 * Resolve the viewer kind for a path, or `null` when the file is not a "成果类"
 * artifact (e.g. pure source code). Shared by the list builder and the content
 * reader so the list and the on-open fetch always agree on how to render.
 */
export function resolveArtifactPreviewKind(path: string): RuntimeArtifactPreviewKind | null {
	const ext = getExtension(path);
	if (MARKDOWN_EXTENSIONS.has(ext)) {
		return "markdown";
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return "image";
	}
	if (JSON_EXTENSIONS.has(ext)) {
		return "json";
	}
	if (TEXT_EXTENSIONS.has(ext)) {
		return "text";
	}
	if (BINARY_DOC_EXTENSIONS.has(ext)) {
		return "binary";
	}
	return null;
}

function titleCaseSlug(slug: string): string {
	return slug
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function artifactTypeLabel(slug: string): string {
	return KNOWN_TYPE_LABELS[slug] ?? (slug ? titleCaseSlug(slug) : "Other");
}

/**
 * Classify a path into a `{ type, label }` pair using only path conventions.
 * Specific conventions are checked before the generic `docs/<type>/` rule so
 * that e.g. `docs/superpowers/specs/` maps to `spec` rather than `superpowers`.
 */
export function classifyArtifactType(path: string): { type: string; label: string } {
	const normalized = path.replace(/\\/g, "/");
	const lower = normalized.toLowerCase();

	if (lower.includes("docs/superpowers/specs/")) {
		return { type: "spec", label: KNOWN_TYPE_LABELS.spec ?? "Spec" };
	}
	if (lower.startsWith(".plan/") || lower.includes("/.plan/")) {
		return { type: "report", label: KNOWN_TYPE_LABELS.report ?? "Report" };
	}
	if (lower.startsWith(".capsio/") || lower.includes("/.capsio/")) {
		return { type: "report", label: KNOWN_TYPE_LABELS.report ?? "Report" };
	}

	const segments = normalized.split("/").filter(Boolean);
	const docsIndex = segments.indexOf("docs");
	// Need at least `docs/<type>/<file>` so the type segment isn't the file itself.
	if (docsIndex !== -1 && segments.length > docsIndex + 2) {
		const slug = segments[docsIndex + 1];
		if (slug) {
			return { type: slug, label: artifactTypeLabel(slug) };
		}
	}

	return { type: "other", label: "Other" };
}

function toArtifactStatus(status: RuntimeWorkspaceFileStatus): RuntimeArtifactStatus {
	if (status === "added" || status === "untracked" || status === "copied") {
		return "new";
	}
	return "modified";
}

/**
 * Build the read-only artifact list from observed worktree changes. Deleted
 * files are dropped (the weak reference disappears) and non-artifact files
 * (source code, lockfiles, …) are filtered out by extension. The result is
 * de-duplicated by path and sorted by label then path for stable grouping.
 */
export function detectArtifacts(changes: ArtifactChangeInput[]): RuntimeArtifact[] {
	const byPath = new Map<string, RuntimeArtifact>();

	for (const change of changes) {
		if (change.status === "deleted") {
			continue;
		}
		const previewKind = resolveArtifactPreviewKind(change.path);
		if (!previewKind) {
			continue;
		}
		if (byPath.has(change.path)) {
			continue;
		}
		const { type, label } = classifyArtifactType(change.path);
		byPath.set(change.path, {
			path: change.path,
			type,
			label,
			status: toArtifactStatus(change.status),
			previewKind,
		});
	}

	return Array.from(byPath.values()).sort(
		(left, right) => left.label.localeCompare(right.label) || left.path.localeCompare(right.path),
	);
}
