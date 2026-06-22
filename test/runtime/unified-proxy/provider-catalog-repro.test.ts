import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../../utilities/temp-dir";

vi.mock("../../../src/logging", () => ({
	createLogger: () => ({
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
	}),
}));

vi.mock("../../../src/fs/locked-file-system", () => ({
	lockedFileSystem: {
		writeJsonFileAtomic: vi.fn(async (_path: string, data: unknown) => {
			const target = (globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath;
			if (target) {
				const dir = target.substring(0, target.lastIndexOf("/"));
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(target, JSON.stringify(data, null, 2));
			}
		}),
	},
}));

import {
	getAllAgentProviderSets,
	redactAgentProviderSets,
	resetAgentProviderConfigCache,
	saveAgentProvider,
} from "../../../src/agent-sdk/kanban/agent-provider-config";

describe("agent provider save round-trip", () => {
	let temp: ReturnType<typeof createTempDir>;
	let originalEnv: string | undefined;
	let providersPath: string;

	beforeEach(() => {
		temp = createTempDir("kanban-provider-roundtrip-");
		providersPath = join(temp.path, "agent_providers.json");
		(globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath = providersPath;
		originalEnv = process.env.KANBAN_AGENT_PROVIDERS_PATH;
		process.env.KANBAN_AGENT_PROVIDERS_PATH = providersPath;
		resetAgentProviderConfigCache();
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.KANBAN_AGENT_PROVIDERS_PATH;
		} else {
			process.env.KANBAN_AGENT_PROVIDERS_PATH = originalEnv;
		}
		(globalThis as { __testAgentProvidersPath?: string }).__testAgentProvidersPath = undefined;
		resetAgentProviderConfigCache();
		temp.cleanup();
	});

	it("preserves base URL + model + key across a save (single agent)", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			apiKey: "sk-secret-1234567890",
			model: "gpt-4o",
			models: ["gpt-4o"],
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
		});

		resetAgentProviderConfigCache();
		const set = getAllAgentProviderSets().claude;
		const provider = set?.providers.find((p) => p.provider === "my-relay");
		expect(provider?.apiKey).toBe("sk-secret-1234567890");
		expect(provider?.baseUrl).toBe("https://relay.example.com/v1");
		expect(provider?.protocols?.[0]?.baseUrl).toBe("https://relay.example.com/v1");
		expect(provider?.model).toBe("gpt-4o");
	});

	it("does not persist a transient apiKeyPreview echoed back by the client", async () => {
		// The redacted set the web client merges edits onto carries `apiKeyPreview`.
		// If that masked hint round-trips into storage it would corrupt the on-disk
		// shape and could later be mistaken for a real value.
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "my-relay",
			apiKey: "sk-real-key-000000",
			protocols: [{ protocol: "openai", baseUrl: "https://relay.example.com/v1" }],
			// Simulate the client echoing a masked preview back on save.
			apiKeyPreview: "sk-r…0000",
		} as Parameters<typeof saveAgentProvider>[1]);

		const onDisk = readFileSync(providersPath, "utf8");
		expect(onDisk).not.toContain("apiKeyPreview");
		expect(onDisk).not.toContain("sk-r…0000");
		// The real key must survive untouched.
		resetAgentProviderConfigCache();
		const provider = getAllAgentProviderSets().claude?.providers[0];
		expect(provider?.apiKey).toBe("sk-real-key-000000");
	});

	it("redaction surfaces a per-agent key preview after a real save", async () => {
		await saveAgentProvider("claude", {
			agentId: "claude",
			provider: "anthropic",
			apiKey: "sk-claude-AAAAAAAAAA",
			protocols: [{ protocol: "anthropic", baseUrl: "https://claude.example.com" }],
		});
		await saveAgentProvider("codex", {
			agentId: "codex",
			provider: "anthropic",
			apiKey: "sk-codex-BBBBBBBBBB",
			protocols: [{ protocol: "openai", baseUrl: "https://codex.example.com" }],
		});

		resetAgentProviderConfigCache();
		const redacted = redactAgentProviderSets(getAllAgentProviderSets());
		const claudePreview = redacted.claude?.providers[0]?.apiKeyPreview;
		const codexPreview = redacted.codex?.providers[0]?.apiKeyPreview;
		expect(claudePreview).toBeTruthy();
		expect(codexPreview).toBeTruthy();
		expect(claudePreview).not.toBe(codexPreview);
		expect(redacted.claude?.providers[0]?.apiKey).toBeUndefined();
	});
});
