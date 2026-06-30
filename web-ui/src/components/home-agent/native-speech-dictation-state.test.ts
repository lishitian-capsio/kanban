import { describe, expect, it } from "vitest";

import {
	appendDictationText,
	describeSpeechDictationError,
	describeSpeechDictationUnsupported,
	describeSpeechDictationUnsupportedTooltip,
	detectSpeechDictationSupport,
} from "./native-speech-dictation-state";

describe("detectSpeechDictationSupport", () => {
	it("is unsupported when there is no window (SSR)", () => {
		expect(detectSpeechDictationSupport(null)).toEqual({ supported: false, reason: "unsupported-browser" });
		expect(detectSpeechDictationSupport(undefined)).toEqual({ supported: false, reason: "unsupported-browser" });
	});

	it("is unsupported when the browser lacks the SpeechRecognition constructor", () => {
		expect(detectSpeechDictationSupport({ isSecureContext: true })).toEqual({
			supported: false,
			reason: "unsupported-browser",
		});
	});

	it("reports insecure-context when the constructor exists but the page is plain HTTP", () => {
		// This is the LAN/HTTP bug: webkitSpeechRecognition exists, so the old check
		// said "supported", but start() then fails with a misleading not-allowed error.
		expect(detectSpeechDictationSupport({ webkitSpeechRecognition: () => {}, isSecureContext: false })).toEqual({
			supported: false,
			reason: "insecure-context",
		});
	});

	it("is supported when a constructor exists in a secure context", () => {
		expect(detectSpeechDictationSupport({ SpeechRecognition: () => {}, isSecureContext: true })).toEqual({
			supported: true,
		});
		expect(detectSpeechDictationSupport({ webkitSpeechRecognition: () => {}, isSecureContext: true })).toEqual({
			supported: true,
		});
	});

	it("assumes a secure context when isSecureContext is unavailable (older browsers)", () => {
		expect(detectSpeechDictationSupport({ webkitSpeechRecognition: () => {} })).toEqual({ supported: true });
	});
});

describe("describeSpeechDictationUnsupported", () => {
	it("guides toward HTTPS/localhost for an insecure context", () => {
		const message = describeSpeechDictationUnsupported("insecure-context");
		expect(message).toMatch(/HTTPS or localhost/);
		// Must not surface the raw, ambiguous browser error.
		expect(message).not.toMatch(/blocked/i);
	});

	it("explains an unsupported browser", () => {
		expect(describeSpeechDictationUnsupported("unsupported-browser")).toMatch(/not supported|isn't supported/i);
	});
});

describe("describeSpeechDictationUnsupportedTooltip", () => {
	it("mentions HTTPS/localhost for an insecure context", () => {
		expect(describeSpeechDictationUnsupportedTooltip("insecure-context")).toMatch(/HTTPS or localhost/);
	});

	it("mentions the browser for an unsupported browser", () => {
		expect(describeSpeechDictationUnsupportedTooltip("unsupported-browser")).toMatch(/browser/i);
	});
});

describe("describeSpeechDictationError", () => {
	it("gives actionable copy for a denied permission", () => {
		const message = describeSpeechDictationError("not-allowed");
		expect(message).toMatch(/Allow microphone access/);
		expect(describeSpeechDictationError("service-not-allowed")).toBe(message);
	});

	it("maps the known error codes", () => {
		expect(describeSpeechDictationError("audio-capture")).toMatch(/no microphone/i);
		expect(describeSpeechDictationError("no-speech")).toMatch(/no speech/i);
		expect(describeSpeechDictationError("network")).toMatch(/service/i);
		expect(describeSpeechDictationError("aborted")).toMatch(/stopped/i);
	});

	it("falls back to the provided message, then a generic line, for unknown codes", () => {
		expect(describeSpeechDictationError("weird-code", "boom")).toBe("boom");
		expect(describeSpeechDictationError("weird-code")).toMatch(/unexpectedly/i);
		expect(describeSpeechDictationError("weird-code", "")).toMatch(/unexpectedly/i);
	});
});

describe("appendDictationText", () => {
	it("replaces an empty/whitespace draft with the trimmed transcript", () => {
		expect(appendDictationText("", "  hello  ")).toBe("hello");
		expect(appendDictationText("   ", "hello")).toBe("hello");
	});

	it("ignores an empty transcript", () => {
		expect(appendDictationText("keep me", "   ")).toBe("keep me");
	});

	it("inserts a separating space only when needed", () => {
		expect(appendDictationText("hello", "world")).toBe("hello world");
		expect(appendDictationText("hello ", "world")).toBe("hello world");
		expect(appendDictationText("hello\n", "world")).toBe("hello\nworld");
	});
});
