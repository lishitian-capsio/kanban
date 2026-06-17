import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAgentProviderConfigCache, saveAgentProvider } from "../../src/agent-sdk/kanban/agent-provider-config";
import { createAgentProfile, selectAgentProfile } from "../../src/state/agent-profile-registry";
import {
	loadWorkspaceAgentProfiles,
	loadWorkspaceContext,
	mutateWorkspaceAgentProfiles,
} from "../../src/state/workspace-state";
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

describe.sequential("agent profiles integration", () => {
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

	it("migrates existing agent provider config into a selected default pi profile (no secrets)", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-agent-profiles-");
			try {
				// Seed the user's per-agent provider config (incl. a secret API key).
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

				const data = await loadWorkspaceAgentProfiles(context.workspaceId);
				expect(data.profiles).toHaveLength(1);
				const profile = data.profiles[0];
				expect(profile?.agentId).toBe("pi");
				expect(profile?.providerId).toBe("openai");
				expect(profile?.modelId).toBe("gpt-5");
				// The migrated profile is selected for the pi agent.
				expect(data.selectedByAgent.pi).toBe(profile?.id);
				// Secrets never land in the committed profile record.
				expect(JSON.stringify(profile)).not.toContain("sk-secret-key");
			} finally {
				cleanup();
			}
		});
	});

	it("persists create + select through mutateWorkspaceAgentProfiles", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-agent-profiles-");
			try {
				const workspacePath = join(sandboxRoot, "project");
				mkdirSync(workspacePath, { recursive: true });
				initGitRepository(workspacePath);
				const context = await loadWorkspaceContext(workspacePath);

				await mutateWorkspaceAgentProfiles(context.workspaceId, (current) => {
					const created = createAgentProfile(current, {
						id: "anthropic-default",
						name: "Claude",
						agentId: "pi",
						providerId: "anthropic",
						modelId: "claude-sonnet-4",
						reasoningEffort: "high",
					});
					return selectAgentProfile(created, "pi", "anthropic-default");
				});

				// Re-read from disk (sharded profiles + selection file).
				const reloaded = await loadWorkspaceAgentProfiles(context.workspaceId);
				const created = reloaded.profiles.find((p) => p.id === "anthropic-default");
				expect(created?.modelId).toBe("claude-sonnet-4");
				expect(created?.reasoningEffort).toBe("high");
				expect(reloaded.selectedByAgent.pi).toBe("anthropic-default");
			} finally {
				cleanup();
			}
		});
	});
});
