import { describe, expect, it } from "vitest";

import {
	assertResolvedPiModel,
	PI_DEFAULT_MODEL_ID,
	PI_DEFAULT_PROVIDER_ID,
	resolvePiModel,
} from "../../src/agent-sdk/kanban/pi-provider-config";

// Regression guard for the pi-only model-resolution fallback.
//
// Mechanism under test: `getBundledModel` is typed to return a non-null
// `Model`, but at runtime returns `undefined` for an unknown id. The final
// fallback in `resolvePiModel` re-fetches the bundled default and would pass
// that value straight into `new Agent({ model })`. If the default ever went
// missing from `models.json`, the model would be `undefined` and the agent
// would crash on a property read deep inside the SDK.
//
// Today the default IS present, so resolution never yields undefined. These
// tests pin that invariant AND verify the guard turns a future-missing default
// into a clear, actionable error instead of an opaque crash.
describe("resolvePiModel fallback always returns a defined model", () => {
	it("returns a defined model for the default (no args) path", () => {
		const resolved = resolvePiModel();
		expect(resolved.model).toBeTruthy();
		expect(resolved.provider).toBe(PI_DEFAULT_PROVIDER_ID);
		expect(resolved.modelId).toBe(PI_DEFAULT_MODEL_ID);
	});

	it("returns the bundled default for unknown provider+model with no baseUrl (final fallback)", () => {
		const resolved = resolvePiModel("no-such-provider", "no-such-model");
		expect(resolved.model).toBeTruthy();
		expect(resolved.provider).toBe(PI_DEFAULT_PROVIDER_ID);
		expect(resolved.modelId).toBe(PI_DEFAULT_MODEL_ID);
		// The model the Agent constructor reads must carry the identifying fields.
		expect(resolved.model.id).toBeTruthy();
		expect(resolved.model.api).toBeTruthy();
	});
});

describe("assertResolvedPiModel guard", () => {
	it("returns the model unchanged when present", () => {
		const model = { id: "x", api: "anthropic-messages" } as never;
		expect(assertResolvedPiModel(model, "anthropic", "x")).toBe(model);
	});

	it("throws a clear error (not an opaque crash) when the model is missing", () => {
		expect(() => assertResolvedPiModel(undefined, "anthropic", "ghost-model")).toThrow(/ghost-model/);
		expect(() => assertResolvedPiModel(undefined, "anthropic", "ghost-model")).toThrow(/bundled model registry/);
	});
});
