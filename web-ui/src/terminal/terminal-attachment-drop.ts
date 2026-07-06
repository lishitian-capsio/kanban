// Drag/paste-to-attachment support for terminal-backed CLI agents (currently
// claude). A CLI agent's stdin is text-only, so a dropped/pasted file can't be
// streamed to it directly. Instead we persist the bytes into the task worktree
// and inject an `@/absolute/path` mention into the terminal, which claude reads
// off disk. This module holds the DOM-free, unit-testable core; the React panel
// supplies the concrete `upload`/`inject`/`onError` side effects.

import { buildMentionInsertText } from "@/components/detail-panels/kanban-chat-composer-completion";

export interface TerminalAttachmentUploadResult {
	ok: boolean;
	/** Absolute on-disk path of the written attachment (present when `ok`). */
	path?: string;
	error?: string;
}

/**
 * Collect every File from a drag/paste `DataTransfer` — any type, not just
 * images, since a CLI agent can `@`-mention arbitrary files. Prefers `items`
 * (reliable for clipboard paste, where `files` is often empty) then falls back
 * to `files`. Must be called synchronously during the event.
 */
export function collectFilesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
	if (!dataTransfer) {
		return [];
	}
	const files: File[] = [];
	if (dataTransfer.items && dataTransfer.items.length > 0) {
		for (let index = 0; index < dataTransfer.items.length; index += 1) {
			const item = dataTransfer.items[index];
			if (!item || item.kind !== "file") {
				continue;
			}
			const file = item.getAsFile();
			if (file) {
				files.push(file);
			}
		}
	}
	if (files.length === 0 && dataTransfer.files) {
		for (const file of Array.from(dataTransfer.files)) {
			files.push(file);
		}
	}
	return files;
}

/** Minimal shape of a paste event this module needs, so the decision logic is
 * testable without a DOM. Satisfied by both a native `ClipboardEvent` and React's
 * synthetic one. */
export interface TerminalPasteEventLike {
	clipboardData: DataTransfer | null;
	preventDefault(): void;
	stopImmediatePropagation(): void;
}

/**
 * Decide whether a paste into the terminal carries files (OS-copied files or a
 * clipboard image) and should become attachments, or is plain text that xterm
 * should paste normally.
 *
 * When files are present it intercepts: `preventDefault()` +
 * `stopImmediatePropagation()` stop the file bytes reaching xterm's own
 * bubble-phase paste handlers (which live on the same textarea/element and would
 * otherwise swallow the event), then hands the files to `onFiles`. When there are
 * none it returns `false` and touches nothing, leaving xterm's text paste intact.
 *
 * Must be wired as a CAPTURE-phase native listener on an ancestor of the xterm
 * textarea so it runs before xterm's target-phase handlers.
 */
export function handleTerminalPasteEvent(event: TerminalPasteEventLike, onFiles: (files: File[]) => void): boolean {
	const files = collectFilesFromDataTransfer(event.clipboardData);
	if (files.length === 0) {
		return false;
	}
	event.preventDefault();
	event.stopImmediatePropagation();
	onFiles(files);
	return true;
}

/**
 * Format the text injected into the terminal for a written attachment path.
 * Reuses the composer's mention builder (quotes paths containing spaces) and
 * appends a trailing space so the next token is separated. No newline — the user
 * reviews the mention and submits themselves.
 */
export function buildAttachmentMentionText(absolutePath: string): string {
	return `${buildMentionInsertText(absolutePath)} `;
}

/** Read a File's bytes as a base64 string, or null on read failure. */
export function readFileAsBase64(file: File): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				resolve(null);
				return;
			}
			resolve(result.split(",")[1] ?? null);
		};
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

/**
 * Upload each dropped/pasted file and inject an `@path` mention on success.
 * Sequential (files usually number one or two) so the injected mentions land in
 * a stable order and never race. A failed or throwing upload is rolled back to a
 * single `onError` call and injects nothing for that file. All side effects are
 * injected, so the ordering/success/failure logic is unit-testable.
 */
export async function processTerminalAttachments(params: {
	files: File[];
	upload: (file: File) => Promise<TerminalAttachmentUploadResult>;
	inject: (text: string) => void;
	onError: (message: string) => void;
}): Promise<{ injected: number; failed: number }> {
	let injected = 0;
	let failed = 0;
	for (const file of params.files) {
		let result: TerminalAttachmentUploadResult;
		try {
			result = await params.upload(file);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (result.ok && result.path) {
			params.inject(buildAttachmentMentionText(result.path));
			injected += 1;
		} else {
			params.onError(result.error ?? `Could not attach ${file.name || "file"}.`);
			failed += 1;
		}
	}
	return { injected, failed };
}
