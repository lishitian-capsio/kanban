// Maximum size we will read into memory and base64-encode for a single upload.
// The library is meant for reference assets, not large media, so we cap generously but firmly.
export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

export interface FileUploadPayload {
	name: string;
	/** Base64-encoded file contents, ready for the `workspace.addFile` mutation. */
	data: string;
	/** Browser-reported MIME type, forwarded as an override; empty when unknown. */
	mime: string;
}

/**
 * Read a browser {@link File} into the base64 payload accepted by the file library backend.
 * Resolves to `null` when the file exceeds {@link MAX_UPLOAD_SIZE_BYTES} or cannot be read.
 */
export async function readFileAsUploadPayload(file: File): Promise<FileUploadPayload | null> {
	if (file.size > MAX_UPLOAD_SIZE_BYTES) {
		return null;
	}
	return await new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				resolve(null);
				return;
			}
			const base64 = result.split(",")[1];
			if (!base64) {
				resolve(null);
				return;
			}
			resolve({ name: file.name || "untitled", data: base64, mime: file.type });
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

/**
 * Collect every dropped/pasted file from a DataTransfer. Unlike the task-image collector this
 * accepts all file types. Must be called synchronously during the event -- browsers clear the
 * DataTransfer after the synchronous dispatch window.
 */
export function collectFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
	const files: File[] = [];
	if (dataTransfer.items && dataTransfer.items.length > 0) {
		for (let i = 0; i < dataTransfer.items.length; i++) {
			const item = dataTransfer.items[i];
			if (!item || item.kind !== "file") {
				continue;
			}
			const file = item.getAsFile();
			if (file) {
				files.push(file);
			}
		}
	}
	if (files.length === 0) {
		for (const file of Array.from(dataTransfer.files)) {
			files.push(file);
		}
	}
	return files;
}
