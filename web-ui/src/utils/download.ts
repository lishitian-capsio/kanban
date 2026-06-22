/**
 * Browser file-download helpers. The backend returns export payloads as text
 * (single `.md`) or a base64 zip (archive); these turn that into a save dialog
 * via a transient object URL + synthetic anchor click — the same self-contained
 * pattern the artifact viewer uses, with no file route.
 */

/** Trigger a browser download of `blob` under `fileName`. */
export function downloadBlob(fileName: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = fileName;
		anchor.rel = "noopener";
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Download UTF-8 text (defaults to a markdown content type). */
export function downloadText(fileName: string, text: string, mimeType = "text/markdown;charset=utf-8"): void {
	downloadBlob(fileName, new Blob([text], { type: mimeType }));
}

/** Decode a base64 payload and download it as a binary file. */
export function downloadBase64(fileName: string, base64: string, mimeType: string): void {
	downloadBlob(fileName, new Blob([base64ToBytes(base64)], { type: mimeType }));
}

/**
 * A filesystem-safe, lowercase-dashed basename for a download (e.g. `Requirements`
 * → `requirements`), falling back to `fallback` when nothing printable survives.
 */
export function safeFileSlug(name: string, fallback = "file"): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : fallback;
}

/** Decode a base64 string to its raw bytes (the inverse of `btoa`). */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	// Back the view with a concrete ArrayBuffer so it is a valid `BlobPart`.
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
