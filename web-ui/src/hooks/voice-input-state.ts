// Pure state machine + result-handling helpers for push-to-talk voice input.
// Kept free of MediaRecorder / DOM so the transitions, the timer formatting, and
// the transcript-into-draft handling can be unit-tested without a browser. The
// `useVoiceInput` hook drives this reducer; the composer renders from its status.

/** Lifecycle of one push-to-talk capture. Errors surface via toast and return to idle. */
export type VoiceInputStatus = "idle" | "requesting" | "recording" | "transcribing";

export interface VoiceInputState {
	status: VoiceInputStatus;
	/** Epoch ms the recording started, for the elapsed timer; null when not recording. */
	startedAt: number | null;
}

export const initialVoiceInputState: VoiceInputState = { status: "idle", startedAt: null };

export type VoiceInputEvent =
	/** User toggled on — asking for microphone permission. */
	| { type: "request" }
	/** Permission granted and the recorder started. */
	| { type: "granted"; at: number }
	/** User toggled off — uploading for transcription. */
	| { type: "stop" }
	/** Transcription returned (success). */
	| { type: "transcribed" }
	/** Any failure (permission denied, no device, recorder/network error). */
	| { type: "failed" }
	/** Hard reset (e.g. component unmount / task switch). */
	| { type: "reset" };

/**
 * Deterministic transition function. Out-of-order events (e.g. `stop` while idle)
 * leave the state unchanged so a stray event can't wedge the machine.
 */
export function voiceInputReducer(state: VoiceInputState, event: VoiceInputEvent): VoiceInputState {
	switch (event.type) {
		case "request":
			return state.status === "idle" ? { status: "requesting", startedAt: null } : state;
		case "granted":
			return state.status === "requesting" ? { status: "recording", startedAt: event.at } : state;
		case "stop":
			return state.status === "recording" ? { status: "transcribing", startedAt: null } : state;
		case "transcribed":
			return state.status === "transcribing" ? initialVoiceInputState : state;
		case "failed":
			return state.status === "idle" ? state : initialVoiceInputState;
		case "reset":
			return initialVoiceInputState;
		default:
			return state;
	}
}

/** Format an elapsed duration (ms) as `m:ss`, clamping negatives to zero. */
export function formatRecordingElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Normalize a raw transcript before it reaches the draft (trim; empty stays empty). */
export function prepareTranscript(text: string): string {
	return text.trim();
}

/**
 * Insert a transcript into the composer draft. Empty drafts are replaced outright;
 * non-empty drafts get the transcript on a fresh blank line; an empty transcript
 * leaves the draft untouched. Shared by the composer's voice handler and the chat
 * panel's `appendToDraft` imperative handle so both behave identically.
 */
export function appendTranscriptToDraft(draft: string, text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return draft;
	}
	if (draft.trim().length === 0) {
		return trimmed;
	}
	return `${draft.trimEnd()}\n\n${trimmed}`;
}
