import { describe, expect, it } from "vitest";

import {
	appendTranscriptToDraft,
	formatRecordingElapsed,
	initialVoiceInputState,
	prepareTranscript,
	voiceInputReducer,
} from "./voice-input-state";

describe("voiceInputReducer", () => {
	it("starts idle", () => {
		expect(initialVoiceInputState.status).toBe("idle");
	});

	it("goes idle → requesting → recording on grant", () => {
		const requesting = voiceInputReducer(initialVoiceInputState, { type: "request" });
		expect(requesting.status).toBe("requesting");

		const recording = voiceInputReducer(requesting, { type: "granted", at: 1000 });
		expect(recording.status).toBe("recording");
		expect(recording.startedAt).toBe(1000);
	});

	it("goes recording → transcribing → idle", () => {
		const recording = voiceInputReducer(voiceInputReducer(initialVoiceInputState, { type: "request" }), {
			type: "granted",
			at: 1000,
		});
		const transcribing = voiceInputReducer(recording, { type: "stop" });
		expect(transcribing.status).toBe("transcribing");

		const done = voiceInputReducer(transcribing, { type: "transcribed" });
		expect(done.status).toBe("idle");
		expect(done.startedAt).toBeNull();
	});

	it("returns to idle from any active state on failure", () => {
		const requesting = voiceInputReducer(initialVoiceInputState, { type: "request" });
		expect(voiceInputReducer(requesting, { type: "failed" }).status).toBe("idle");

		const recording = voiceInputReducer(requesting, { type: "granted", at: 1 });
		expect(voiceInputReducer(recording, { type: "failed" }).status).toBe("idle");

		const transcribing = voiceInputReducer(recording, { type: "stop" });
		expect(voiceInputReducer(transcribing, { type: "failed" }).status).toBe("idle");
	});

	it("ignores out-of-order events", () => {
		// Can't stop when idle, can't grant when not requesting.
		expect(voiceInputReducer(initialVoiceInputState, { type: "stop" })).toEqual(initialVoiceInputState);
		expect(voiceInputReducer(initialVoiceInputState, { type: "granted", at: 5 })).toEqual(initialVoiceInputState);
	});

	it("reset always returns to idle", () => {
		const recording = voiceInputReducer(voiceInputReducer(initialVoiceInputState, { type: "request" }), {
			type: "granted",
			at: 1000,
		});
		const reset = voiceInputReducer(recording, { type: "reset" });
		expect(reset.status).toBe("idle");
		expect(reset.startedAt).toBeNull();
	});
});

describe("formatRecordingElapsed", () => {
	it("formats sub-minute durations as m:ss", () => {
		expect(formatRecordingElapsed(0)).toBe("0:00");
		expect(formatRecordingElapsed(5_000)).toBe("0:05");
		expect(formatRecordingElapsed(65_000)).toBe("1:05");
	});

	it("clamps negatives to zero", () => {
		expect(formatRecordingElapsed(-500)).toBe("0:00");
	});
});

describe("prepareTranscript", () => {
	it("trims surrounding whitespace", () => {
		expect(prepareTranscript("  hello world  ")).toBe("hello world");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(prepareTranscript("   \n  ")).toBe("");
	});
});

describe("appendTranscriptToDraft", () => {
	it("returns the trimmed transcript when the draft is empty", () => {
		expect(appendTranscriptToDraft("", "hello")).toBe("hello");
		expect(appendTranscriptToDraft("   ", "hello")).toBe("hello");
	});

	it("appends with a blank line when the draft has content", () => {
		expect(appendTranscriptToDraft("first line", "second")).toBe("first line\n\nsecond");
	});

	it("leaves the draft unchanged for an empty transcript", () => {
		expect(appendTranscriptToDraft("keep me", "   ")).toBe("keep me");
	});
});
