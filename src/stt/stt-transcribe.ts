// Pure, side-effect-free helpers for speech-to-text (STT) transcription plus the
// single impure `transcribeAudio` egress. Kept free of I/O so URL building, the
// response shape, audio-size validation, and error mapping can be unit-tested
// without a network — mirroring `agent-sdk/kanban/model-discovery.ts`.

import { classifyModelFetchError } from "../agent-sdk/kanban/model-discovery";
import type { PersistedSttConfig } from "./stt-types";

/** Default OpenAI-compatible transcription model when none is configured. */
export const DEFAULT_STT_MODEL = "whisper-1";

/**
 * Hard cap on a single uploaded clip (decoded bytes). 25 MB is the common
 * OpenAI-compatible request ceiling; we stay a touch under it. Push-to-talk
 * clips are far smaller, so this only guards against a runaway recording.
 */
export const MAX_STT_AUDIO_BYTES = 24 * 1024 * 1024;

/** Trim whitespace and strip trailing slashes from a configured base URL. */
export function normalizeSttBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Builds the OpenAI-compatible audio-transcriptions endpoint for a base URL.
 * The base usually already ends in `/v1` (cloud) or `/v1` of a self-hosted
 * whisper.cpp/faster-whisper server.
 */
export function buildTranscriptionUrl(baseUrl: string): string {
	return `${normalizeSttBaseUrl(baseUrl)}/audio/transcriptions`;
}

/**
 * Extracts the transcript from an OpenAI-compatible transcription payload
 * (`{ text: "..." }`, shared by `response_format: "json"` and `verbose_json`).
 * Returns an empty string for any missing/non-string text rather than throwing,
 * so a silent recording degrades to "nothing recognized" instead of an error.
 */
export function parseTranscriptionResponse(payload: unknown): string {
	if (!payload || typeof payload !== "object") {
		return "";
	}
	const text = (payload as { text?: unknown }).text;
	return typeof text === "string" ? text.trim() : "";
}

/**
 * Validate a decoded audio clip's size. Returns a user-facing message when the
 * clip is empty or exceeds `maxBytes`, otherwise `null`.
 */
export function validateAudioByteLength(byteLength: number, maxBytes = MAX_STT_AUDIO_BYTES): string | null {
	if (byteLength <= 0) {
		return "No audio was captured. Try recording again.";
	}
	if (byteLength > maxBytes) {
		const mb = Math.round(maxBytes / (1024 * 1024));
		return `Recording is too large (over ${mb} MB). Record a shorter clip.`;
	}
	return null;
}

export interface ClassifySttErrorArgs {
	url: string;
	/** The thrown network error, when the request never produced a response. */
	error?: unknown;
	/** HTTP status, when the request produced a non-OK response. */
	status?: number;
	statusText?: string;
}

/**
 * Maps an STT request failure to a clear, actionable message. HTTP statuses get
 * STT-specific guidance (key/base-URL/clip-length); network-level failures
 * (refused/DNS/timeout/TLS) delegate to the shared {@link classifyModelFetchError}
 * so the two paths describe a dead host identically.
 */
export function classifySttError(args: ClassifySttErrorArgs): string {
	const { url, error, status, statusText } = args;
	if (typeof status === "number") {
		if (status === 401 || status === 403) {
			return `Speech-to-text authentication failed (HTTP ${status}). Check the STT API key in Settings.`;
		}
		if (status === 404) {
			return `Speech-to-text endpoint not found (HTTP 404). Check the base URL in Settings.`;
		}
		if (status === 413) {
			return "Recording is too large for the speech-to-text endpoint. Record a shorter clip.";
		}
		if (status === 429) {
			return "Speech-to-text is rate limited (HTTP 429). Wait a moment and try again.";
		}
		const suffix = statusText ? ` ${statusText}` : "";
		return `Speech-to-text request failed: HTTP ${status}${suffix}.`;
	}
	return classifyModelFetchError({ url, error });
}

export interface TranscribeAudioInput {
	/** Decoded audio bytes of the recorded clip. */
	bytes: Buffer | Uint8Array;
	/** MIME type of the recording (e.g. `audio/webm`). */
	mime: string;
	/** Optional per-request language override (ISO-639-1, e.g. `zh`). */
	language?: string;
}

/** Thrown by {@link transcribeAudio} with an already user-facing message. */
export class SttTranscriptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SttTranscriptionError";
	}
}

function fileExtensionForMime(mime: string): string {
	const subtype = mime.split("/")[1]?.split(";")[0]?.trim() ?? "";
	if (subtype.includes("webm")) return "webm";
	if (subtype.includes("ogg") || subtype.includes("opus")) return "ogg";
	if (subtype.includes("mp4") || subtype.includes("m4a")) return "mp4";
	if (subtype.includes("mpeg") || subtype.includes("mp3")) return "mp3";
	if (subtype.includes("wav")) return "wav";
	return "webm";
}

/**
 * Upload a recorded clip to the configured OpenAI-compatible STT endpoint and
 * return the transcript. Uses a bare `fetch` (multipart form) so it auto-routes
 * through the runtime's unified outbound proxy (`config/proxy-fetch.ts`); the API
 * key is sent only as a `Bearer` header and never logged. Throws
 * {@link SttTranscriptionError} with a classified, user-facing message on failure.
 */
export async function transcribeAudio(config: PersistedSttConfig, input: TranscribeAudioInput): Promise<string> {
	const sizeError = validateAudioByteLength(input.bytes.byteLength);
	if (sizeError) {
		throw new SttTranscriptionError(sizeError);
	}
	const url = buildTranscriptionUrl(config.baseUrl);
	const model = config.model.trim() || DEFAULT_STT_MODEL;
	const language = (input.language ?? config.language)?.trim();

	const form = new FormData();
	// Copy into a fresh, plain-ArrayBuffer-backed view. This file is typechecked under
	// both the runtime (no DOM lib) and web-ui (DOM lib, via the tRPC router type import);
	// `new Uint8Array(length)` is backed by a plain `ArrayBuffer`, which satisfies the DOM
	// lib's stricter `BlobPart` (an `ArrayBufferLike`-backed view does not).
	const view = new Uint8Array(input.bytes.byteLength);
	view.set(input.bytes);
	const blob = new Blob([view], { type: input.mime });
	form.append("file", blob, `audio.${fileExtensionForMime(input.mime)}`);
	form.append("model", model);
	form.append("response_format", "json");
	if (language) {
		form.append("language", language);
	}

	const headers: Record<string, string> = {};
	if (config.apiKey && config.apiKey.trim().length > 0) {
		headers.Authorization = `Bearer ${config.apiKey.trim()}`;
	}

	let response: Response;
	try {
		response = await fetch(url, { method: "POST", headers, body: form });
	} catch (error) {
		throw new SttTranscriptionError(classifySttError({ url, error }));
	}
	if (!response.ok) {
		throw new SttTranscriptionError(
			classifySttError({ url, status: response.status, statusText: response.statusText }),
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new SttTranscriptionError(classifySttError({ url, error }));
	}
	return parseTranscriptionResponse(payload);
}
