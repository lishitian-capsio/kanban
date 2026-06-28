import type { ClipboardSelectionType, IClipboardProvider } from "@xterm/addon-clipboard";

import { createLogger } from "@/utils/logger";

const log = createLogger("terminal-clipboard");

// The system clipboard selection (`c`). `ClipboardSelectionType` is a `const
// enum` in the addon typings, so it has no runtime representation and cannot be
// imported as a value — mirror the addon's own source, which compares against
// the raw `'c'` literal.
const SYSTEM_SELECTION = "c" as ClipboardSelectionType;

/**
 * Why a system-clipboard write could not be completed, so the caller can give
 * the user an honest, accurate reason instead of silently dropping it.
 *
 * - `insecure-context`: the async Clipboard API is unavailable (no
 *   `navigator.clipboard`), which happens outside a secure context — plain HTTP
 *   over a LAN — and the synchronous `execCommand` fallback also failed.
 * - `blocked`: the Clipboard API exists but the browser rejected the write
 *   (e.g. the document is not focused, or permission was denied), and the
 *   fallback also failed.
 */
export type ClipboardWriteFailureReason = "insecure-context" | "blocked";

export interface SafeClipboardProviderOptions {
	/**
	 * Invoked when a system-clipboard write fails on every available path. Lets
	 * the host surface honest feedback (e.g. a toast) rather than the addon
	 * silently dropping an OSC 52 copy while the agent claims it was "sent".
	 */
	onWriteFailure?: (reason: ClipboardWriteFailureReason) => void;
}

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
 * Synchronous clipboard-write fallback for non-secure contexts, where the async
 * Clipboard API is absent. Selects an off-screen textarea and runs the legacy
 * `execCommand("copy")`. This is the only path that can reach the system
 * clipboard over plain HTTP. Returns whether the copy succeeded; never throws.
 *
 * It briefly moves focus to the textarea (selection requires it), so the
 * previously focused element (the terminal) is refocused afterwards to keep it
 * receiving input.
 */
function copyTextViaExecCommand(text: string): boolean {
	if (typeof document === "undefined" || typeof document.execCommand !== "function") {
		return false;
	}
	const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.setAttribute("aria-hidden", "true");
	Object.assign(textarea.style, {
		position: "fixed",
		top: "-9999px",
		left: "-9999px",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(textarea);
	try {
		textarea.select();
		textarea.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch (error) {
		log.debug("execCommand clipboard fallback threw", { error });
		return false;
	} finally {
		textarea.remove();
		previousActiveElement?.focus?.();
	}
}

/**
 * A clipboard provider for `@xterm/addon-clipboard` that degrades gracefully
 * when the async Clipboard API is unavailable, and reports honest failure.
 *
 * `navigator.clipboard` is only defined in a secure context (HTTPS or
 * localhost); over plain HTTP on a LAN it is `undefined`. The addon's default
 * `BrowserClipboardProvider` reads `navigator.clipboard.writeText` directly, so
 * an incoming OSC 52 clipboard-write sequence throws an uncaught `TypeError`
 * mid-parse and breaks terminal rendering. Same secure-context class of guard as
 * `safeRandomUUID` and the voice-input button.
 *
 * For an OSC 52 write this provider tries, in order: the async Clipboard API,
 * then a synchronous `execCommand("copy")` fallback (which can succeed even in a
 * non-secure context). If every path fails it calls `onWriteFailure` so the host
 * can tell the user the copy did not happen — the CLI agent prints "sent N chars
 * via OSC 52" optimistically, so without this the failure would be invisible.
 */
export function createSafeClipboardProvider(options: SafeClipboardProviderOptions = {}): IClipboardProvider {
	return {
		async writeText(selection, text) {
			if (selection !== SYSTEM_SELECTION) {
				return;
			}
			const write = clipboardWriteText();
			if (write) {
				try {
					await write(text);
					return;
				} catch (error) {
					log.debug("async clipboard write failed; trying execCommand fallback", { error });
				}
			}
			if (copyTextViaExecCommand(text)) {
				return;
			}
			const reason: ClipboardWriteFailureReason = write ? "blocked" : "insecure-context";
			log.debug("clipboard write failed on every path", { reason });
			options.onWriteFailure?.(reason);
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
