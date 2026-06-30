// Pure helpers for the new-chat-thread dialog's native (Web Speech API) dictation.
// Kept free of React / DOM event objects so support detection, the error-to-message
// mapping, and the transcript-append behaviour can be unit-tested without a browser.
// The `useNativeSpeechDictation` hook drives these; the dialog renders from them.

/** Why native dictation can't run here. */
export type SpeechDictationUnsupportedReason = "unsupported-browser" | "insecure-context";

export type SpeechDictationSupport =
	| { supported: true }
	| { supported: false; reason: SpeechDictationUnsupportedReason };

/** The slice of `window` support detection reads — narrowed for testability. */
export interface SpeechDictationWindowLike {
	isSecureContext?: boolean;
	SpeechRecognition?: unknown;
	webkitSpeechRecognition?: unknown;
}

/**
 * Decide whether native speech dictation can actually work in this environment.
 *
 * The Web Speech API is gated to secure contexts: on a plain-HTTP LAN origin the
 * `webkitSpeechRecognition` constructor still EXISTS, but `start()` later fails
 * asynchronously with a `not-allowed` error that reads like a permission denial.
 * Detecting the insecure context up front lets the UI disable the control and show
 * an actionable "needs HTTPS/localhost" message instead of that misleading error —
 * the same secure-context guard the STT path (`use-voice-input.ts`) already applies.
 */
export function detectSpeechDictationSupport(
	win: SpeechDictationWindowLike | null | undefined,
): SpeechDictationSupport {
	if (!win) {
		return { supported: false, reason: "unsupported-browser" };
	}
	const hasConstructor = Boolean(win.SpeechRecognition ?? win.webkitSpeechRecognition);
	if (!hasConstructor) {
		return { supported: false, reason: "unsupported-browser" };
	}
	const secure = typeof win.isSecureContext === "boolean" ? win.isSecureContext : true;
	if (!secure) {
		return { supported: false, reason: "insecure-context" };
	}
	return { supported: true };
}

/** Actionable message for why dictation is unavailable, shown in the dialog status line. */
export function describeSpeechDictationUnsupported(reason: SpeechDictationUnsupportedReason): string {
	switch (reason) {
		case "insecure-context":
			return "Voice input needs a secure page (HTTPS or localhost). Type the opening prompt instead.";
		case "unsupported-browser":
			return "Voice input isn't supported in this browser. Type the opening prompt instead.";
	}
}

/** Short tooltip variant of {@link describeSpeechDictationUnsupported}. */
export function describeSpeechDictationUnsupportedTooltip(reason: SpeechDictationUnsupportedReason): string {
	switch (reason) {
		case "insecure-context":
			return "Voice input needs HTTPS or localhost";
		case "unsupported-browser":
			return "Voice input is not supported in this browser";
	}
}

/**
 * Map a `SpeechRecognitionErrorEvent.error` code (plus its optional message) to a
 * human, actionable string. A genuine `not-allowed` in a secure context means the
 * user denied the mic, so the copy points them at the browser permission — the
 * insecure-context case never reaches here because support detection blocks it.
 */
export function describeSpeechDictationError(code: string, fallbackMessage?: string): string {
	switch (code) {
		case "not-allowed":
		case "service-not-allowed":
			return "Microphone access was blocked. Allow microphone access for this page in your browser, then try again.";
		case "audio-capture":
			return "No microphone was detected.";
		case "language-not-supported":
			return "Speech recognition is not available for this browser language.";
		case "network":
			return "Speech recognition could not reach the browser service.";
		case "no-speech":
			return "No speech was detected. Try again or type the description.";
		case "aborted":
			return "Voice input stopped.";
		default:
			return fallbackMessage && fallbackMessage.length > 0 ? fallbackMessage : "Voice input stopped unexpectedly.";
	}
}

/** Append a fresh dictation chunk to the current draft, spacing it cleanly. */
export function appendDictationText(value: string, transcript: string): string {
	const trimmedTranscript = transcript.trim();
	if (!trimmedTranscript) {
		return value;
	}
	if (!value.trim()) {
		return trimmedTranscript;
	}
	const separator = /[\s\n]$/.test(value) ? "" : " ";
	return `${value}${separator}${trimmedTranscript}`;
}
