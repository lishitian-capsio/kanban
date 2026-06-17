import { describe, expect, it } from "vitest";

import {
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	type ProviderFormValidationInput,
	validateProviderForm,
} from "@/components/shared/provider-form-validation";

function baseInput(overrides: Partial<ProviderFormValidationInput> = {}): ProviderFormValidationInput {
	return {
		baseUrl: "https://api.example.com/v1",
		apiKey: "",
		modelsSourceUrl: "",
		timeoutMs: "",
		models: ["gpt-4o"],
		defaultModelId: "gpt-4o",
		headers: [],
		...overrides,
	};
}

describe("validateProviderForm", () => {
	it("returns no field errors for a well-formed input", () => {
		const errors = validateProviderForm(baseInput());
		expect(errors.baseUrl).toBeUndefined();
		expect(errors.apiKey).toBeUndefined();
		expect(errors.modelsSourceUrl).toBeUndefined();
		expect(errors.timeoutMs).toBeUndefined();
		expect(errors.defaultModelId).toBeUndefined();
		expect(errors.headers).toEqual({});
	});

	describe("baseUrl", () => {
		it("rejects a value that is not a valid URL", () => {
			expect(validateProviderForm(baseInput({ baseUrl: "not a url" })).baseUrl).toBeDefined();
		});

		it("rejects a non-http(s) protocol", () => {
			expect(validateProviderForm(baseInput({ baseUrl: "ftp://example.com" })).baseUrl).toBeDefined();
		});

		it("accepts a localhost http URL with a port", () => {
			expect(validateProviderForm(baseInput({ baseUrl: "http://localhost:8000/v1" })).baseUrl).toBeUndefined();
		});

		it("does not flag an empty base URL (the required check is separate)", () => {
			expect(validateProviderForm(baseInput({ baseUrl: "" })).baseUrl).toBeUndefined();
		});
	});

	describe("modelsSourceUrl", () => {
		it("rejects an invalid URL when present", () => {
			expect(validateProviderForm(baseInput({ modelsSourceUrl: "://bad" })).modelsSourceUrl).toBeDefined();
		});

		it("ignores an empty value", () => {
			expect(validateProviderForm(baseInput({ modelsSourceUrl: "" })).modelsSourceUrl).toBeUndefined();
		});
	});

	describe("apiKey", () => {
		it("rejects a key containing whitespace", () => {
			expect(validateProviderForm(baseInput({ apiKey: "sk-abc def" })).apiKey).toBeDefined();
		});

		it("rejects a key containing a newline", () => {
			expect(validateProviderForm(baseInput({ apiKey: "sk-abc\n" })).apiKey).toBeDefined();
		});

		it("accepts a normal key", () => {
			expect(validateProviderForm(baseInput({ apiKey: "sk-abc123-XYZ_456" })).apiKey).toBeUndefined();
		});

		it("ignores an empty key (it is optional)", () => {
			expect(validateProviderForm(baseInput({ apiKey: "" })).apiKey).toBeUndefined();
		});
	});

	describe("timeoutMs", () => {
		it("rejects a non-integer", () => {
			expect(validateProviderForm(baseInput({ timeoutMs: "12.5" })).timeoutMs).toBeDefined();
		});

		it("rejects a value below the minimum", () => {
			expect(validateProviderForm(baseInput({ timeoutMs: String(MIN_TIMEOUT_MS - 1) })).timeoutMs).toBeDefined();
		});

		it("rejects a value above the maximum", () => {
			expect(validateProviderForm(baseInput({ timeoutMs: String(MAX_TIMEOUT_MS + 1) })).timeoutMs).toBeDefined();
		});

		it("accepts a value within range", () => {
			expect(validateProviderForm(baseInput({ timeoutMs: "30000" })).timeoutMs).toBeUndefined();
		});

		it("ignores an empty value", () => {
			expect(validateProviderForm(baseInput({ timeoutMs: "" })).timeoutMs).toBeUndefined();
		});
	});

	describe("defaultModelId", () => {
		it("rejects a default model not present in the model list", () => {
			expect(
				validateProviderForm(baseInput({ models: ["a", "b"], defaultModelId: "c" })).defaultModelId,
			).toBeDefined();
		});

		it("accepts a default model present in the list", () => {
			expect(
				validateProviderForm(baseInput({ models: ["a", "b"], defaultModelId: "b" })).defaultModelId,
			).toBeUndefined();
		});

		it("ignores an empty default when there are no models yet", () => {
			expect(validateProviderForm(baseInput({ models: [], defaultModelId: "" })).defaultModelId).toBeUndefined();
		});
	});

	describe("headers", () => {
		it("rejects an invalid header name", () => {
			const errors = validateProviderForm(baseInput({ headers: [{ id: "h1", key: "Bad Header", value: "x" }] }));
			expect(errors.headers.h1?.key).toBeDefined();
		});

		it("rejects a header value with a control character", () => {
			const errors = validateProviderForm(
				baseInput({ headers: [{ id: "h1", key: "X-Token", value: "line1\nline2" }] }),
			);
			expect(errors.headers.h1?.value).toBeDefined();
		});

		it("requires a name when only a value is provided", () => {
			const errors = validateProviderForm(baseInput({ headers: [{ id: "h1", key: "", value: "orphan" }] }));
			expect(errors.headers.h1?.key).toBeDefined();
		});

		it("ignores a fully empty row", () => {
			const errors = validateProviderForm(baseInput({ headers: [{ id: "h1", key: "", value: "" }] }));
			expect(errors.headers.h1).toBeUndefined();
		});

		it("accepts a valid header", () => {
			const errors = validateProviderForm(
				baseInput({ headers: [{ id: "h1", key: "X-Custom-Header", value: "abc-123" }] }),
			);
			expect(errors.headers.h1).toBeUndefined();
		});
	});

	it("aggregates field errors and reports the form has blocking errors", () => {
		const errors = validateProviderForm(baseInput({ baseUrl: "nope", timeoutMs: "-5", apiKey: "bad key" }));
		expect(errors.hasBlockingErrors).toBe(true);
	});

	it("reports no blocking errors for a clean input", () => {
		expect(validateProviderForm(baseInput()).hasBlockingErrors).toBe(false);
	});
});
