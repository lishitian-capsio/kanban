import JSZip from "jszip";

/** One file destined for an export archive: its archive-relative path and exact bytes. */
export interface VaultExportEntry {
	/** Path inside the archive, mirroring the on-disk layout, e.g. `docs/requirement/<slug>-<id>.md`. */
	entryPath: string;
	/** Exact UTF-8 file content — the same bytes git tracks, never a reconstruction. */
	content: string;
}

/**
 * Pack vault documents into a single zip archive, returned base64-encoded so it
 * rides the existing base64 byte-download channel (mirrors {@link FileLibraryStore}'s
 * `getBytes`). Each entry keeps its `docs/<type>/<file>` path so the archive
 * reproduces the vault's on-disk tree.
 */
export async function buildVaultZipBase64(entries: VaultExportEntry[]): Promise<string> {
	const zip = new JSZip();
	for (const entry of entries) {
		zip.file(entry.entryPath, entry.content);
	}
	return await zip.generateAsync({ type: "base64" });
}
