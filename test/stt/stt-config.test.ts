import { describe, expect, it } from "vitest";

import { deriveSttStatus, mergeSttConfigForSave } from "../../src/stt/stt-config";

describe("deriveSttStatus", () => {
	it("reports an unconfigured status for a null config", () => {
		expect(deriveSttStatus(null)).toEqual({
			configured: false,
			baseUrl: null,
			model: null,
			language: null,
			hasApiKey: false,
			apiKeyPreview: null,
		});
	});

	it("masks the stored key and reports configured", () => {
		const status = deriveSttStatus({
			baseUrl: "https://api.openai.com/v1",
			model: "whisper-1",
			language: "zh",
			apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
		});
		expect(status.configured).toBe(true);
		expect(status.baseUrl).toBe("https://api.openai.com/v1");
		expect(status.model).toBe("whisper-1");
		expect(status.language).toBe("zh");
		expect(status.hasApiKey).toBe(true);
		expect(status.apiKeyPreview).toContain("…");
		// The full secret must never appear in the preview.
		expect(status.apiKeyPreview).not.toContain("efghijklmnop");
	});

	it("reports no key for a self-hosted config without a key", () => {
		const status = deriveSttStatus({ baseUrl: "http://localhost:8080/v1", model: "whisper-1" });
		expect(status.hasApiKey).toBe(false);
		expect(status.apiKeyPreview).toBeNull();
		expect(status.language).toBeNull();
	});
});

describe("mergeSttConfigForSave", () => {
	it("normalizes the base URL and defaults the model", () => {
		const next = mergeSttConfigForSave(null, { baseUrl: "https://api.openai.com/v1/" });
		expect(next.baseUrl).toBe("https://api.openai.com/v1");
		expect(next.model).toBe("whisper-1");
	});

	it("keeps the existing key when apiKey is undefined", () => {
		const next = mergeSttConfigForSave(
			{ baseUrl: "https://a/v1", model: "whisper-1", apiKey: "sk-keepme" },
			{ baseUrl: "https://b/v1", model: "gpt-4o-transcribe" },
		);
		expect(next.apiKey).toBe("sk-keepme");
		expect(next.baseUrl).toBe("https://b/v1");
		expect(next.model).toBe("gpt-4o-transcribe");
	});

	it("clears the key when apiKey is an empty string", () => {
		const next = mergeSttConfigForSave(
			{ baseUrl: "https://a/v1", model: "whisper-1", apiKey: "sk-old" },
			{ baseUrl: "https://a/v1", apiKey: "" },
		);
		expect(next.apiKey).toBeUndefined();
	});

	it("sets a new trimmed key when provided", () => {
		const next = mergeSttConfigForSave(null, { baseUrl: "https://a/v1", apiKey: "  sk-new  " });
		expect(next.apiKey).toBe("sk-new");
	});

	it("clears the language with an empty string and keeps it when undefined", () => {
		const cleared = mergeSttConfigForSave(
			{ baseUrl: "https://a/v1", model: "whisper-1", language: "zh" },
			{ baseUrl: "https://a/v1", language: "" },
		);
		expect(cleared.language).toBeUndefined();

		const kept = mergeSttConfigForSave(
			{ baseUrl: "https://a/v1", model: "whisper-1", language: "zh" },
			{ baseUrl: "https://a/v1" },
		);
		expect(kept.language).toBe("zh");
	});
});
