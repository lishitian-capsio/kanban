import type { RuntimeVaultDocument, RuntimeVaultFrontmatterValue } from "@/runtime/types";

/**
 * Client-side projection of a vault document. The backend (`RuntimeVaultDocument`)
 * is the source of truth — frontmatter is already parsed server-side — so this
 * model is a thin, view-friendly rename (`title` → `name`, matching the Files
 * library's `RuntimeFileItem.name`) plus convenience accessors. Keep it free of
 * tRPC/IO so views and the board grouping logic stay trivially testable.
 */
export interface VaultDoc {
	id: string;
	type: string;
	name: string;
	frontmatter: Record<string, RuntimeVaultFrontmatterValue>;
	body: string;
	relativePath: string;
	createdAt: number;
	updatedAt: number;
}

export function toVaultDoc(document: RuntimeVaultDocument): VaultDoc {
	return {
		id: document.id,
		type: document.type,
		name: document.title,
		frontmatter: document.frontmatter,
		body: document.body,
		relativePath: document.relativePath,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

/** Read a frontmatter value as a display string ("" when absent/null). */
export function frontmatterString(doc: VaultDoc, key: string): string {
	const value = doc.frontmatter[key];
	if (value === undefined || value === null) {
		return "";
	}
	if (Array.isArray(value)) {
		return value.join(", ");
	}
	return String(value);
}
