import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAgentProviderConfigCache, saveAgentProvider } from "../../src/agent-sdk/kanban/agent-provider-config";
import { loadWorkspaceCommittedProviders, loadWorkspaceContext } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

describe.sequential("committed providers integration", () => {
	let settingsTemp: { path: string; cleanup: () => void };
	const previousSettingsPath = process.env.KANBAN_AGENT_PROVIDERS_PATH;

	beforeEach(() => {
		settingsTemp = createTempDir("kanban-agent-config-");
		process.env.KANBAN_AGENT_PROVIDERS_PATH = join(settingsTemp.path, "agent_providers.json");
		resetAgentProviderConfigCache();
	});

	afterEach(() => {
		if (previousSettingsPath === undefined) delete process.env.KANBAN_AGENT_PROVIDERS_PATH;
		else process.env.KANBAN_AGENT_PROVIDERS_PATH = previousSettingsPath;
		resetAgentProviderConfigCache();
		settingsTemp.cleanup();
	});

	it("migrates machine-home provider config into a selected committed provider (no secrets)", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-committed-providers-");
			try {
				// Seed the user's machine-home per-agent provider config (incl. a secret API key).
				await saveAgentProvider("pi", {
					agentId: "pi",
					provider: "openai",
					model: "gpt-5",
					apiKey: "sk-secret-key",
					baseUrl: "https://api.openai.test/v1",
				});

				const workspacePath = join(sandboxRoot, "project");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				// loadWorkspaceContext runs prepareRepoRuntimeHome → the one-time migration.
				const context = await loadWorkspaceContext(workspacePath);

				const data = await loadWorkspaceCommittedProviders(context.workspaceId);
				expect(data.providers).toHaveLength(1);
				const provider = data.providers[0];
				expect(provider?.agentId).toBe("pi");
				expect(provider?.scope).toBe("workspace");
				expect(provider?.providerId).toBe("openai");
				expect(provider?.modelId).toBe("gpt-5");
				expect(provider?.baseUrl).toBe("https://api.openai.test/v1");
				// The migrated provider is selected for the pi agent (by provider id).
				expect(data.selectedByAgent.pi).toBe("openai");
				// Secrets never land in the committed record.
				expect(JSON.stringify(provider)).not.toContain("sk-secret-key");
			} finally {
				cleanup();
			}
		});
	});

	it("creates no committed providers when there is no machine-home config", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-committed-providers-");
			try {
				const workspacePath = join(sandboxRoot, "project");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);

				const context = await loadWorkspaceContext(workspacePath);
				const data = await loadWorkspaceCommittedProviders(context.workspaceId);
				expect(data.providers).toEqual([]);
				expect(data.selectedByAgent).toEqual({});
			} finally {
				cleanup();
			}
		});
	});
});
