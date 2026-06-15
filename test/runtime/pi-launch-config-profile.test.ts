import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePiLaunchConfig } from "../../src/agent-sdk/kanban/pi-provider-config";
import { resetAgentProviderConfigCache } from "../../src/agent-sdk/kanban/agent-provider-config";
import { createTempDir } from "../utilities/temp-dir";

// Point the per-agent config store at an empty temp path so the only
// "workspace layer" in play is the profile we pass in explicitly.
let temp: { path: string; cleanup: () => void };
const previousPath = process.env.KANBAN_AGENT_PROVIDERS_PATH;

beforeEach(() => {
	temp = createTempDir("pi-launch-profile-");
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

describe("resolvePiLaunchConfig with a selected profile (workspace layer)", () => {
	it("uses the profile's provider/model/baseUrl/reasoning when no override is given", () => {
		const config = resolvePiLaunchConfig({
			workspaceProfile: {
				providerId: "openai",
				modelId: "gpt-5",
				baseUrl: "https://example.test/v1",
				reasoningEffort: "high",
			},
		});
		expect(config.providerId).toBe("openai");
		expect(config.modelId).toBe("gpt-5");
		expect(config.baseUrl).toBe("https://example.test/v1");
		expect(config.reasoningEffort).toBe("high");
	});

	it("lets explicit overrides win over the profile", () => {
		const config = resolvePiLaunchConfig({
			providerIdOverride: "anthropic",
			modelIdOverride: "claude-sonnet-4",
			reasoningEffortOverride: "low",
			workspaceProfile: { providerId: "openai", modelId: "gpt-5", baseUrl: null, reasoningEffort: "high" },
		});
		expect(config.providerId).toBe("anthropic");
		expect(config.modelId).toBe("claude-sonnet-4");
		expect(config.reasoningEffort).toBe("low");
	});

	it("falls back to defaults when no profile and no stored settings", () => {
		const config = resolvePiLaunchConfig({});
		expect(config.providerId).toBe("anthropic");
		expect(config.modelId).toBe("claude-sonnet-4-20250514");
	});

	it("ignores a null/empty profile and falls back to defaults", () => {
		const config = resolvePiLaunchConfig({ workspaceProfile: null });
		expect(config.providerId).toBe("anthropic");
	});
});
