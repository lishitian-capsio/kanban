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
//   2. the workspace's selected agent profile (`workspaceProfile`),
//   3. the user's saved per-agent provider settings (machine-home store),
//   4. built-in defaults.
//
// The store layer is reached by pointing `KANBAN_AGENT_PROVIDERS_PATH` at a temp
// file we write per-test, then resetting the in-memory cache.

let temp: { path: string; cleanup: () => void };
const previousPath = process.env.KANBAN_AGENT_PROVIDERS_PATH;

/** Write a single pi provider config to the store the resolver reads from. */
function writePiStore(config: {
	provider?: string;
	model?: string;
	baseUrl?: string;
	reasoningEffort?: string;
}): void {
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

	it("fills only the unresolved core fields, leaving profile values intact", () => {
		writePiStore({ provider: "openai", model: "gpt-5", baseUrl: "https://store.test/v1" });

		const config = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "anthropic", modelId: null },
		});

		// provider came from the profile; model + baseUrl filled from the store.
		expect(config.providerId).toBe("anthropic");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://store.test/v1");
	});
});

describe("resolvePiLaunchConfig — priority ordering", () => {
	it("override beats profile beats store beats defaults for provider/model", () => {
		writePiStore({ provider: "store-provider", model: "store-model" });

		const overrideWins = resolvePiLaunchConfig({
			providerIdOverride: "override-provider",
			modelIdOverride: "override-model",
			workspaceProfile: { providerId: "profile-provider", modelId: "profile-model" },
		});
		expect(overrideWins.providerId).toBe("override-provider");
		expect(overrideWins.modelId).toBe("override-model");

		const profileWins = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "profile-provider", modelId: "profile-model" },
		});
		expect(profileWins.providerId).toBe("profile-provider");
		expect(profileWins.modelId).toBe("profile-model");

		const storeWins = resolvePiLaunchConfig({});
		expect(storeWins.providerId).toBe("store-provider");
		expect(storeWins.modelId).toBe("store-model");
	});

	it("takes base URL from the store; a profile cannot supply or override it", () => {
		writePiStore({ baseUrl: "https://store.test/v1" });

		// The profile is a pure reference (no base URL field), so even a fully-set
		// profile cannot override the store's base URL.
		const config = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "openai", modelId: "gpt-5" },
		});

		expect(config.baseUrl).toBe("https://store.test/v1");
	});

	it("reasoning override (nullish) beats profile reasoning", () => {
		const config = resolvePiLaunchConfig({
			reasoningEffortOverride: "low",
			workspaceProfile: { providerId: "openai", modelId: "gpt-5", reasoningEffort: "high" },
		});

		expect(config.reasoningEffort).toBe("low");
	});
});

describe("resolvePiLaunchConfig — store reasoning", () => {
	// Base URL is supplied only by the store (neither the override nor the profile
	// carries one), so a core field is always unresolved after the override and
	// profile layers and the store is always consulted. Its reasoningEffort is
	// filled in that same pass whenever override/profile did not already set one.
	it("applies the store reasoningEffort when override/profile leave it unset", () => {
		writePiStore({ provider: "store-provider", model: "store-model", reasoningEffort: "high" });

		const config = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "openai", modelId: "gpt-5", reasoningEffort: null },
		});

		expect(config.reasoningEffort).toBe("high");
	});

	it("keeps the profile reasoningEffort over the store's when the profile sets one", () => {
		writePiStore({ provider: "store-provider", model: "store-model", reasoningEffort: "high" });

		const config = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "openai", modelId: "gpt-5", reasoningEffort: "low" },
		});

		expect(config.reasoningEffort).toBe("low");
	});

	it("applies the store reasoningEffort when a core field still needs the store", () => {
		writePiStore({ model: "store-model", reasoningEffort: "high" });

		// modelId is unresolved, so the store layer is consulted and its
		// reasoningEffort is filled in the same pass.
		const config = resolvePiLaunchConfig({
			workspaceProfile: { providerId: "openai", modelId: null, reasoningEffort: null },
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
			workspaceProfile: { providerId: "openai", modelId: "gpt-5" },
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
