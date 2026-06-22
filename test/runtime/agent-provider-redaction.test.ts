import { describe, expect, it } from "vitest";
import { redactAgentProviderSets } from "../../src/agent-sdk/kanban/agent-provider-config";

describe("redactAgentProviderSets", () => {
	it("strips apiKey from every provider but keeps other fields", () => {
		const out = redactAgentProviderSets({
			pi: {
				agentId: "pi",
				defaultProviderId: "anthropic",
				providers: [{ agentId: "pi", provider: "anthropic", apiKey: "sk-secret", baseUrl: "https://x" }],
			},
		});
		expect(out.pi.providers[0].apiKey).toBeUndefined();
		expect(out.pi.providers[0].baseUrl).toBe("https://x");
		expect(out.pi.defaultProviderId).toBe("anthropic");
	});

	it("exposes a masked apiKeyPreview (never the raw key) per provider", () => {
		const rawKey = "sk-secret-1234567890";
		const out = redactAgentProviderSets({
			pi: {
				agentId: "pi",
				providers: [{ agentId: "pi", provider: "anthropic", apiKey: rawKey }],
			},
		});
		const preview = out.pi.providers[0].apiKeyPreview;
		expect(preview, "a configured key must surface a non-empty masked hint").toBeTruthy();
		expect(preview).not.toBe(rawKey);
		// The mask must reveal neither the full body nor be a 1:1 echo.
		expect(out.pi.providers[0].apiKey).toBeUndefined();
	});

	it("gives each agent its OWN preview for a same-named provider (no cross-agent collision)", () => {
		// "anthropic"/"openai"/reused relay names commonly collide across agents.
		// The per-agent set must keep each agent's distinct key preview so the edit
		// dialog for agent A never shows agent B's (or an empty) key.
		const out = redactAgentProviderSets({
			claude: {
				agentId: "claude",
				providers: [{ agentId: "claude", provider: "anthropic", apiKey: "sk-claude-AAAAAAAAAA" }],
			},
			codex: {
				agentId: "codex",
				providers: [{ agentId: "codex", provider: "anthropic", apiKey: "sk-codex-BBBBBBBBBB" }],
			},
		});
		const a = out.claude.providers[0].apiKeyPreview;
		const b = out.codex.providers[0].apiKeyPreview;
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it("sets apiKeyPreview to null when no key is configured", () => {
		const out = redactAgentProviderSets({
			pi: { agentId: "pi", providers: [{ agentId: "pi", provider: "local" }] },
		});
		expect(out.pi.providers[0].apiKeyPreview).toBeNull();
	});
});
