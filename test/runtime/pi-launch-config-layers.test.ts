import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAgentProviderConfigCache } from "../../src/agent-sdk/kanban/agent-provider-config";
import {
	PI_DEFAULT_MODEL_ID,
	PI_DEFAULT_PROVIDER_ID,
	resolvePiLaunchConfig,
} from "../../src/agent-sdk/kanban/pi-provider-config";
import { createTempDir } from "../utilities/temp-dir";

// Characterization tests for the layered resolution in `resolvePiLaunchConfig`.
//
// Resolution chain (highest priority first):
//   1. explicit per-session overrides (`*Override`),
//   2. the workspace's selected committed provider (`committedProvider`),
//   3. the user's saved per-agent provider settings (machine-home store),
//   4. built-in defaults.
//
// The store layer is reached by pointing `KANBAN_AGENT_PROVIDERS_PATH` at a temp
// file we write per-test, then resetting the in-memory cache.

let temp: { path: string; cleanup: () => void };
const previousPath = process.env.KANBAN_AGENT_PROVIDERS_PATH;

/** Write a single pi provider config to the store the resolver reads from. */
function writePiStore(config: { provider?: string; model?: string; baseUrl?: string; reasoningEffort?: string }): void {
	const path = join(temp.path, "agent_providers.json");
	writeFileSync(
		path,
		JSON.stringify({
			agents: {
				pi: {
					agentId: "pi",
					provider: config.provider,
					model: config.model,
					baseUrl: config.baseUrl,
					reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
				},
			},
		}),
		"utf8",
	);
	resetAgentProviderConfigCache();
}

/** Write a multi-provider pi set (providers[] + default) to the store. */
function writePiStoreSet(set: {
	defaultProviderId: string;
	providers: Array<{ provider: string; model?: string; baseUrl?: string; reasoningEffort?: string; apiKey?: string }>;
}): void {
	const path = join(temp.path, "agent_providers.json");
	writeFileSync(
		path,
		JSON.stringify({
			agents: {
				pi: {
					agentId: "pi",
					defaultProviderId: set.defaultProviderId,
					providers: set.providers.map((p) => ({
						agentId: "pi",
						provider: p.provider,
						model: p.model,
						baseUrl: p.baseUrl,
						apiKey: p.apiKey,
						reasoning: p.reasoningEffort ? { effort: p.reasoningEffort } : undefined,
					})),
				},
			},
		}),
		"utf8",
	);
	resetAgentProviderConfigCache();
}

beforeEach(() => {
	temp = createTempDir("pi-launch-layers-");
	process.env.KANBAN_AGENT_PROVIDERS_PATH = join(temp.path, "agent_providers.json");
	resetAgentProviderConfigCache();
});

afterEach(() => {
	if (previousPath === undefined) {
		delete process.env.KANBAN_AGENT_PROVIDERS_PATH;
	} else {
		process.env.KANBAN_AGENT_PROVIDERS_PATH = previousPath;
	}
	resetAgentProviderConfigCache();
	temp.cleanup();
});

describe("resolvePiLaunchConfig — store layer (machine-home provider settings)", () => {
	it("fills provider/model/baseUrl/reasoning from the store when no override and no profile", () => {
		writePiStore({
			provider: "openai",
			model: "gpt-5",
			baseUrl: "https://store.test/v1",
			reasoningEffort: "medium",
		});

		const config = resolvePiLaunchConfig({});

		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://store.test/v1");
		expect(config.reasoningEffort).toBe("medium");
	});

	it("fills only the unresolved core fields, leaving committed-provider values intact", () => {
		writePiStore({ provider: "openai", model: "gpt-5", baseUrl: "https://store.test/v1" });

		// The committed provider selects the same provider the store holds; the
		// store then fills the model + baseUrl it left unset. (The store is read for
		// the resolved provider, so the model/baseUrl always belong to it.)
		const config = resolvePiLaunchConfig({
			committedProvider: { providerId: "openai", modelId: null, baseUrl: null },
		});

		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://store.test/v1");
	});

	it("does not borrow a different provider's model when the selected provider is absent from the store", () => {
		writePiStore({ provider: "openai", model: "gpt-5", baseUrl: "https://store.test/v1" });

		// The committed provider selects a provider the store does not have, so the
		// store contributes nothing — the model falls through to the built-in default
		// rather than mis-pairing the selected provider with openai's model.
		const config = resolvePiLaunchConfig({
			committedProvider: { providerId: "anthropic", modelId: null, baseUrl: null },
		});

		expect(config.providerId).toBe("anthropic");
		expect(config.modelId).toBe(PI_DEFAULT_MODEL_ID);
		expect(config.baseUrl).toBeNull();
	});
});

describe("resolvePiLaunchConfig — priority ordering", () => {
	it("override beats profile beats store beats defaults for provider/model", () => {
		writePiStore({ provider: "store-provider", model: "store-model" });

		const overrideWins = resolvePiLaunchConfig({
			providerIdOverride: "override-provider",
			modelIdOverride: "override-model",
			committedProvider: { providerId: "profile-provider", modelId: "profile-model" },
		});
		expect(overrideWins.providerId).toBe("override-provider");
		expect(overrideWins.modelId).toBe("override-model");

		const profileWins = resolvePiLaunchConfig({
			committedProvider: { providerId: "profile-provider", modelId: "profile-model" },
		});
		expect(profileWins.providerId).toBe("profile-provider");
		expect(profileWins.modelId).toBe("profile-model");

		const storeWins = resolvePiLaunchConfig({});
		expect(storeWins.providerId).toBe("store-provider");
		expect(storeWins.modelId).toBe("store-model");
	});

	it("a set profile baseUrl wins over the store baseUrl", () => {
		writePiStore({ baseUrl: "https://store.test/v1" });

		const config = resolvePiLaunchConfig({
			committedProvider: { providerId: "openai", modelId: "gpt-5", baseUrl: "https://profile.test/v1" },
		});

		expect(config.baseUrl).toBe("https://profile.test/v1");
	});

	it("reasoning override (nullish) beats profile reasoning", () => {
		const config = resolvePiLaunchConfig({
			reasoningEffortOverride: "low",
			committedProvider: { providerId: "openai", modelId: "gpt-5", reasoningEffort: "high" },
		});

		expect(config.reasoningEffort).toBe("low");
	});
});

describe("resolvePiLaunchConfig — store-reasoning gate quirk", () => {
	// The store layer (including its reasoningEffort) is consulted only when a
	// core field (provider/model/baseUrl) is still unresolved after the override
	// and profile layers. So when override/profile already supply all three core
	// fields, the store's reasoningEffort is NOT applied.
	it("ignores the store reasoningEffort when provider/model/baseUrl are all already resolved", () => {
		writePiStore({ provider: "store-provider", model: "store-model", reasoningEffort: "high" });

		const config = resolvePiLaunchConfig({
			committedProvider: {
				providerId: "openai",
				modelId: "gpt-5",
				baseUrl: "https://profile.test/v1",
				reasoningEffort: null,
			},
		});

		expect(config.reasoningEffort).toBeNull();
	});

	it("applies the store reasoningEffort when a core field still needs the store", () => {
		writePiStore({ provider: "openai", model: "store-model", reasoningEffort: "high" });

		// modelId is unresolved, so the store layer is consulted for the selected
		// provider and its reasoningEffort is filled in the same pass.
		const config = resolvePiLaunchConfig({
			committedProvider: {
				providerId: "openai",
				modelId: null,
				baseUrl: "https://profile.test/v1",
				reasoningEffort: null,
			},
		});

		expect(config.modelId).toBe("store-model");
		expect(config.reasoningEffort).toBe("high");
	});
});

describe("resolvePiLaunchConfig — empty-string and missing-value handling", () => {
	it("treats a whitespace-only override as absent and falls through", () => {
		const config = resolvePiLaunchConfig({
			providerIdOverride: "   ",
			modelIdOverride: "",
			committedProvider: { providerId: "openai", modelId: "gpt-5" },
		});

		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
	});

	it("falls back to built-in defaults when no layer supplies provider/model", () => {
		const config = resolvePiLaunchConfig({});

		expect(config.providerId).toBe(PI_DEFAULT_PROVIDER_ID);
		expect(config.modelId).toBe(PI_DEFAULT_MODEL_ID);
		expect(config.baseUrl).toBeNull();
		expect(config.reasoningEffort).toBeNull();
	});

	it("does not throw when the store file is malformed (falls back to defaults)", () => {
		writeFileSync(join(temp.path, "agent_providers.json"), "{ not valid json", "utf8");
		resetAgentProviderConfigCache();

		const config = resolvePiLaunchConfig({});

		expect(config.providerId).toBe(PI_DEFAULT_PROVIDER_ID);
		expect(config.modelId).toBe(PI_DEFAULT_MODEL_ID);
	});
});

describe("resolvePiLaunchConfig — provider-aware store layer (multi-provider set)", () => {
	// A provider-only session override (no model/baseUrl) must pull the model and
	// base URL from the *overridden* provider's stored config, not from the agent's
	// default provider. This is what lets the home composer switch providers by name
	// alone and still launch with that provider's own model + endpoint.
	it("resolves model + baseUrl from the OVERRIDE provider, not the default", () => {
		writePiStoreSet({
			defaultProviderId: "anthropic",
			providers: [
				{ provider: "anthropic", model: "claude-x", baseUrl: "https://anthropic.test/v1" },
				{ provider: "openai", model: "gpt-5", baseUrl: "https://openai.test/v1" },
			],
		});

		const config = resolvePiLaunchConfig({ providerIdOverride: "openai" });

		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://openai.test/v1");
	});

	it("resolves the default provider's model + baseUrl when there is no override", () => {
		writePiStoreSet({
			defaultProviderId: "anthropic",
			providers: [
				{ provider: "anthropic", model: "claude-x", baseUrl: "https://anthropic.test/v1" },
				{ provider: "openai", model: "gpt-5", baseUrl: "https://openai.test/v1" },
			],
		});

		const config = resolvePiLaunchConfig({});

		expect(config.providerId).toBe("anthropic");
		expect(config.modelId).toBe("claude-x");
		expect(config.baseUrl).toBe("https://anthropic.test/v1");
	});

	it("injects the OVERRIDE provider's API key, not the default provider's", () => {
		// Custom provider names map to env vars that can't exist (the hyphen makes an
		// invalid shell identifier), so the store fallback — the path under test — is
		// always exercised regardless of ambient env.
		writePiStoreSet({
			defaultProviderId: "prov-default",
			providers: [
				{ provider: "prov-default", model: "model-a", apiKey: "default-key" },
				{ provider: "prov-override", model: "model-b", apiKey: "override-key" },
			],
		});

		const config = resolvePiLaunchConfig({ providerIdOverride: "prov-override" });

		expect(config.providerId).toBe("prov-override");
		expect(config.apiKey).toBe("override-key");
	});

	it("a committed-provider selection also steers the store lookup to that provider", () => {
		writePiStoreSet({
			defaultProviderId: "anthropic",
			providers: [
				{ provider: "anthropic", model: "claude-x", baseUrl: "https://anthropic.test/v1" },
				{ provider: "openai", model: "gpt-5", baseUrl: "https://openai.test/v1" },
			],
		});

		const config = resolvePiLaunchConfig({
			committedProvider: { providerId: "openai", modelId: null, baseUrl: null },
		});

		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://openai.test/v1");
	});
});
