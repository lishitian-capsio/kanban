import { describe, expect, it } from "vitest";

import type { AgentProviderSet } from "../../../src/agent-sdk/kanban/agent-provider-config";
import { collectProviderBypassHosts } from "../../../src/agent-sdk/kanban/provider-proxy-bypass";

function set(agentId: string, providers: AgentProviderSet["providers"]): AgentProviderSet {
	return { agentId, providers, defaultProviderId: providers[0] ? providers[0].provider : undefined };
}

describe("collectProviderBypassHosts", () => {
	it("returns no hosts when nothing is flagged", () => {
		const sets = {
			pi: set("pi", [
				{ agentId: "pi", provider: "a", protocols: [{ protocol: "openai", baseUrl: "https://api.a.com/v1" }] },
			]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual([]);
	});

	it("collects the endpoint host of a flagged provider (from protocols[0].baseUrl)", () => {
		const sets = {
			pi: set("pi", [
				{
					agentId: "pi",
					provider: "relay",
					bypassProxy: true,
					protocols: [{ protocol: "openai", baseUrl: "https://relay.internal:8443/v1" }],
				},
			]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual(["relay.internal"]);
	});

	it("falls back to the legacy scalar baseUrl when no protocol baseUrl is present", () => {
		const sets = {
			claude: set("claude", [
				{ agentId: "claude", provider: "x", bypassProxy: true, baseUrl: "https://legacy.example.com" },
			]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual(["legacy.example.com"]);
	});

	it("ignores providers that are not flagged, even on the same agent", () => {
		const sets = {
			pi: set("pi", [
				{
					agentId: "pi",
					provider: "on",
					bypassProxy: true,
					protocols: [{ protocol: "openai", baseUrl: "https://on.com" }],
				},
				{ agentId: "pi", provider: "off", protocols: [{ protocol: "openai", baseUrl: "https://off.com" }] },
			]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual(["on.com"]);
	});

	it("de-duplicates hosts case-insensitively across agents (host-keyed bypass)", () => {
		// Two providers on different agents share a host: it appears once. This is
		// the documented trade-off — the whole host goes direct, not one provider.
		const sets = {
			pi: set("pi", [
				{
					agentId: "pi",
					provider: "a",
					bypassProxy: true,
					protocols: [{ protocol: "openai", baseUrl: "https://API.shared.com/v1" }],
				},
			]),
			claude: set("claude", [
				{
					agentId: "claude",
					provider: "b",
					bypassProxy: true,
					protocols: [{ protocol: "anthropic", baseUrl: "https://api.shared.com" }],
				},
			]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual(["api.shared.com"]);
	});

	it("skips a flagged provider with no recoverable endpoint host", () => {
		const sets = {
			gemini: set("gemini", [{ agentId: "gemini", provider: "vendor", bypassProxy: true }]),
		};
		expect(collectProviderBypassHosts(sets)).toEqual([]);
	});
});
