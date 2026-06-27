import { describe, expect, it } from "vitest";

import {
	buildTranscriptionUrl,
	classifySttError,
	normalizeSttBaseUrl,
	parseTranscriptionResponse,
	validateAudioByteLength,
} from "../../src/stt/stt-transcribe";

describe("normalizeSttBaseUrl", () => {
	it("trims whitespace and strips trailing slashes", () => {
		expect(normalizeSttBaseUrl("  https://api.openai.com/v1/  ")).toBe("https://api.openai.com/v1");
	});

	it("leaves an already-clean base URL unchanged", () => {
		expect(normalizeSttBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
	});
});

describe("buildTranscriptionUrl", () => {
	it("appends the OpenAI-compatible transcriptions path", () => {
		expect(buildTranscriptionUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/audio/transcriptions");
	});

	it("normalizes a trailing slash before appending", () => {
		expect(buildTranscriptionUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1/audio/transcriptions");
	});
});

describe("parseTranscriptionResponse", () => {
	it("returns the trimmed text field", () => {
		expect(parseTranscriptionResponse({ text: "  hello world  " })).toBe("hello world");
	});

	it("returns an empty string when text is missing", () => {
		expect(parseTranscriptionResponse({})).toBe("");
		expect(parseTranscriptionResponse(null)).toBe("");
		expect(parseTranscriptionResponse("nope")).toBe("");
	});

	it("ignores a non-string text field", () => {
		expect(parseTranscriptionResponse({ text: 42 })).toBe("");
	});
});

describe("validateAudioByteLength", () => {
	it("accepts audio within the limit", () => {
		expect(validateAudioByteLength(1024, 2048)).toBeNull();
	});

	it("rejects empty audio", () => {
		expect(validateAudioByteLength(0, 2048)).toMatch(/empty|no audio/i);
	});

	it("rejects audio over the limit with an actionable message", () => {
		const message = validateAudioByteLength(4096, 2048);
		expect(message).toMatch(/too large|shorter/i);
	});
});

describe("classifySttError", () => {
	it("maps auth failures to a key-in-settings hint", () => {
		const message = classifySttError({ url: "https://api.openai.com/v1/audio/transcriptions", status: 401 });
		expect(message).toMatch(/authentication/i);
		expect(message).toMatch(/key/i);
	});

	it("maps 404 to a base-URL hint", () => {
		const message = classifySttError({ url: "https://x/v1/audio/transcriptions", status: 404 });
		expect(message).toMatch(/not found/i);
		expect(message).toMatch(/base url/i);
	});

	it("maps 413 to a shorter-clip hint", () => {
		const message = classifySttError({ url: "https://x", status: 413 });
		expect(message).toMatch(/too large|shorter/i);
	});

	it("delegates connection-refused to a reachable network message", () => {
		const message = classifySttError({
			url: "http://localhost:9/audio/transcriptions",
			error: { code: "ECONNREFUSED" },
		});
		expect(message).toMatch(/refused/i);
	});
});
