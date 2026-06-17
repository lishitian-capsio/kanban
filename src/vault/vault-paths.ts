import { join } from "node:path";

import { getRuntimeHomePath } from "../state/workspace-state";

const FILES_DIR = "files";
const DOCS_DIR = "docs";

/**
 * Type-definition documents live under a `_`-prefixed subdir of `docs/` so the
 * document store's type-dir scan can exclude them by convention (they describe
 * types, they are not user documents of any type).
 */
const TYPES_DIR = "_types";

/** `<repo>/.kanban/files` — the vault root, shared by the doc and blob channels. */
export function getVaultFilesDir(repoPath: string): string {
	return join(getRuntimeHomePath(repoPath), FILES_DIR);
}

/** `<repo>/.kanban/files/docs` — the markdown document tree (one subdir per type). */
export function getVaultDocsDir(repoPath: string): string {
	return join(getVaultFilesDir(repoPath), DOCS_DIR);
}

/** `<repo>/.kanban/files/docs/_types` — the data-driven type-definition documents. */
export function getVaultTypesDir(repoPath: string): string {
	return join(getVaultDocsDir(repoPath), TYPES_DIR);
}
