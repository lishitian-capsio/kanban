// Push-to-talk microphone capture for the chat composer's voice input.
//
// Owns the `MediaRecorder` lifecycle (permission → record → upload → transcribe) and
// drives the pure {@link voiceInputReducer} state machine; the composer renders from
// `status`/`elapsedMs`. The recognized text is handed to `onTranscript` (the composer
// fills it into the draft — it is NEVER auto-sent, matching the draft-then-confirm
// decision in the voice tech-selection doc). Recording uploads to the machine-local
// STT endpoint via the `stt.transcribe` tRPC mutation, which forwards through the
// runtime's unified outbound proxy.
//
// Microphone access requires a secure context (HTTPS or localhost) — over plain HTTP on
// a LAN address `getUserMedia` is unavailable, the same constraint as `crypto.randomUUID`
// (see the safe-uuid note). `isSupported` reflects that so the button can hide cleanly.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import {
	initialVoiceInputState,
	prepareTranscript,
	type VoiceInputStatus,
	voiceInputReducer,
} from "@/hooks/voice-input-state";
import { transcribeAudioClip } from "@/runtime/runtime-config-query";
import { createLogger } from "@/utils/logger";

const log = createLogger("voice-input");

/** Hard cap on a single push-to-talk clip; auto-stops the recorder at this point. */
const MAX_RECORDING_MS = 60_000;

/** How often the elapsed timer ticks while recording. */
const ELAPSED_TICK_MS = 200;

/** MIME types tried in order; the first the browser can record wins. */
const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export interface UseVoiceInputOptions {
	workspaceId: string | null;
	/** Optional language override (ISO-639-1); falls back to the configured default. */
	language?: string;
	/** Receives the recognized, trimmed transcript. The caller decides what to do with it. */
	onTranscript: (text: string) => void;
}

export interface UseVoiceInputResult {
	status: VoiceInputStatus;
	/** Elapsed recording time in ms (0 unless recording). */
	elapsedMs: number;
	/** Whether the browser can record at all (secure context + MediaRecorder). */
	isSupported: boolean;
	/** Click handler: starts recording when idle, stops (→ transcribe) when recording. */
	toggle: () => void;
	/** Abort the current capture without transcribing (e.g. Escape). */
	cancel: () => void;
}

function detectSupport(): boolean {
	if (typeof window === "undefined" || typeof navigator === "undefined") {
		return false;
	}
	const hasRecorder = typeof window.MediaRecorder !== "undefined";
	const hasGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);
	// getUserMedia is gated to secure contexts; on an insecure origin mediaDevices is
	// typically absent, but guard explicitly so the button hides instead of erroring.
	const secure = typeof window.isSecureContext === "boolean" ? window.isSecureContext : true;
	return hasRecorder && hasGetUserMedia && secure;
}

function pickMimeType(): string | undefined {
	if (typeof window.MediaRecorder === "undefined" || typeof window.MediaRecorder.isTypeSupported !== "function") {
		return undefined;
	}
	return PREFERRED_MIME_TYPES.find((type) => window.MediaRecorder.isTypeSupported(type));
}

function describeGetUserMediaError(error: unknown): string {
	const name = error instanceof Error ? error.name : "";
	if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
		return "Microphone permission was denied. Allow microphone access in your browser to use voice input.";
	}
	if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
		return "No microphone was found. Connect a microphone and try again.";
	}
	if (name === "NotReadableError" || name === "TrackStartError") {
		return "The microphone is already in use by another application.";
	}
	return "Could not access the microphone. Check your browser's microphone permissions.";
}

async function blobToBase64(blob: Blob): Promise<string> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio."));
		reader.readAsDataURL(blob);
	});
	// Strip the `data:<mime>;base64,` prefix.
	const comma = dataUrl.indexOf(",");
	return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}

export function useVoiceInput({ workspaceId, language, onTranscript }: UseVoiceInputOptions): UseVoiceInputResult {
	const [state, dispatch] = useReducer(voiceInputReducer, initialVoiceInputState);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [isSupported] = useState(detectSupport);

	const recorderRef = useRef<MediaRecorder | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const timerRef = useRef<number | null>(null);
	const autoStopRef = useRef<number | null>(null);
	const cancelledRef = useRef(false);
	// Avoid a stale closure: the recorder's onstop fires later, read the latest callback.
	const onTranscriptRef = useRef(onTranscript);
	onTranscriptRef.current = onTranscript;
	const languageRef = useRef(language);
	languageRef.current = language;
	const workspaceIdRef = useRef(workspaceId);
	workspaceIdRef.current = workspaceId;

	const clearTimers = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearInterval(timerRef.current);
			timerRef.current = null;
		}
		if (autoStopRef.current !== null) {
			window.clearTimeout(autoStopRef.current);
			autoStopRef.current = null;
		}
	}, []);

	const releaseStream = useCallback(() => {
		const stream = streamRef.current;
		if (stream) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
			streamRef.current = null;
		}
		recorderRef.current = null;
	}, []);

	const transcribe = useCallback(async (blob: Blob, mime: string) => {
		try {
			const audioData = await blobToBase64(blob);
			if (audioData.length === 0) {
				throw new Error("No audio was captured. Try recording again.");
			}
			const response = await transcribeAudioClip(workspaceIdRef.current, {
				audioData,
				mime,
				language: languageRef.current,
			});
			if (cancelledRef.current) {
				return;
			}
			const text = prepareTranscript(response.text);
			if (text.length === 0) {
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message: "No speech was recognized.",
					timeout: 4000,
				});
			} else {
				onTranscriptRef.current(text);
			}
			dispatch({ type: "transcribed" });
		} catch (error) {
			log.warn("transcription failed", { error });
			if (!cancelledRef.current) {
				showAppToast({
					intent: "danger",
					icon: "error",
					message: error instanceof Error && error.message ? error.message : "Could not transcribe the recording.",
					timeout: 6000,
				});
			}
			dispatch({ type: "failed" });
		}
	}, []);

	const stop = useCallback(() => {
		clearTimers();
		const recorder = recorderRef.current;
		if (recorder && recorder.state !== "inactive") {
			// onstop (registered in start) finalizes the blob and kicks off transcription.
			recorder.stop();
		}
		dispatch({ type: "stop" });
	}, [clearTimers]);

	const start = useCallback(async () => {
		cancelledRef.current = false;
		dispatch({ type: "request" });
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			log.warn("getUserMedia failed", { error });
			showAppToast({ intent: "danger", icon: "error", message: describeGetUserMediaError(error), timeout: 6000 });
			dispatch({ type: "failed" });
			return;
		}
		if (cancelledRef.current) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
			return;
		}
		streamRef.current = stream;
		chunksRef.current = [];
		const mimeType = pickMimeType();
		let recorder: MediaRecorder;
		try {
			recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
		} catch (error) {
			log.warn("MediaRecorder construction failed", { error });
			showAppToast({
				intent: "danger",
				icon: "error",
				message: "Could not start recording on this device.",
				timeout: 6000,
			});
			releaseStream();
			dispatch({ type: "failed" });
			return;
		}
		recorderRef.current = recorder;
		recorder.ondataavailable = (event: BlobEvent) => {
			if (event.data && event.data.size > 0) {
				chunksRef.current.push(event.data);
			}
		};
		recorder.onstop = () => {
			const effectiveMime = recorder.mimeType || mimeType || "audio/webm";
			const blob = new Blob(chunksRef.current, { type: effectiveMime });
			chunksRef.current = [];
			releaseStream();
			if (cancelledRef.current) {
				return;
			}
			void transcribe(blob, effectiveMime);
		};
		recorder.start();
		const startedAt = Date.now();
		dispatch({ type: "granted", at: startedAt });
		setElapsedMs(0);
		timerRef.current = window.setInterval(() => {
			setElapsedMs(Date.now() - startedAt);
		}, ELAPSED_TICK_MS);
		// Cap the clip length so a forgotten recording can't grow unbounded.
		autoStopRef.current = window.setTimeout(() => {
			stop();
		}, MAX_RECORDING_MS);
	}, [releaseStream, stop, transcribe]);

	const cancel = useCallback(() => {
		cancelledRef.current = true;
		clearTimers();
		const recorder = recorderRef.current;
		if (recorder && recorder.state !== "inactive") {
			recorder.stop();
		}
		releaseStream();
		setElapsedMs(0);
		dispatch({ type: "reset" });
	}, [clearTimers, releaseStream]);

	const toggle = useCallback(() => {
		if (state.status === "recording") {
			stop();
			return;
		}
		if (state.status === "idle") {
			void start();
		}
	}, [start, state.status, stop]);

	// Tear down on unmount: stop the stream, clear timers, drop any in-flight result.
	useEffect(
		() => () => {
			cancelledRef.current = true;
			clearTimers();
			releaseStream();
		},
		[clearTimers, releaseStream],
	);

	return { status: state.status, elapsedMs, isSupported, toggle, cancel };
}
