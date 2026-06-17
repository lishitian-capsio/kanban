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
});
