import type { ClipboardSelectionType, IClipboardProvider } from "@xterm/addon-clipboard";

import { createLogger } from "@/utils/logger";

const log = createLogger("terminal-clipboard");

// The system clipboard selection (`c`). `ClipboardSelectionType` is a `const
// enum` in the addon typings, so it has no runtime representation and cannot be
// imported as a value — mirror the addon's own source, which compares against
// the raw `'c'` literal.
const SYSTEM_SELECTION = "c" as ClipboardSelectionType;

function clipboardWriteText(): ((text: string) => Promise<void>) | null {
	if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
		return null;
	}
	return (text) => navigator.clipboard.writeText(text);
}

function clipboardReadText(): (() => Promise<string>) | null {
	if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
		return null;
	}
	return () => navigator.clipboard.readText();
}

/**
 * A clipboard provider for `@xterm/addon-clipboard` that degrades gracefully
 * when the async Clipboard API is unavailable.
 *
 * `navigator.clipboard` is only defined in a secure context (HTTPS or
 * localhost); over plain HTTP on a LAN it is `undefined`. The addon's default
 * `BrowserClipboardProvider` reads `navigator.clipboard.writeText` directly, so
 * an incoming OSC 52 clipboard-write sequence throws an uncaught `TypeError`
 * mid-parse and breaks terminal rendering. This provider no-ops (and logs at
 * debug) instead, keeping the terminal alive, while delegating to the real
 * Clipboard API whenever it is present. Same secure-context class of guard as
 * `safeRandomUUID` and the voice-input button.
 */
export function createSafeClipboardProvider(): IClipboardProvider {
	return {
		async writeText(selection, text) {
			if (selection !== SYSTEM_SELECTION) {
				return;
			}
			const write = clipboardWriteText();
			if (!write) {
				log.debug("clipboard write skipped: Clipboard API unavailable (insecure context)");
				return;
			}
			try {
				await write(text);
			} catch (error) {
				log.debug("clipboard write failed", { error });
			}
		},
		async readText(selection) {
			if (selection !== SYSTEM_SELECTION) {
				return "";
			}
			const read = clipboardReadText();
			if (!read) {
				log.debug("clipboard read skipped: Clipboard API unavailable (insecure context)");
				return "";
			}
			try {
				return await read();
			} catch (error) {
				log.debug("clipboard read failed", { error });
				return "";
			}
		},
	};
}
