import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	commitAll,
	getAvailablePort,
	initGitRepository,
	runCliCommandAndCollectOutput,
	startRuntimeServer,
	stopRuntimeServer,
} from "../utilities/cli-runtime";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface LinkRecord {
	requirementId: string;
	taskId: string;
	source: "human" | "agent";
	createdAt: number;
}

interface RequirementRecord {
	id: string;
	linkedTaskIds: string[];
	linkedTasks: LinkRecord[];
}

function parseJson<T>(result: { stdout: string; stderr: string; exitCode: number | null }): T {
	if (result.exitCode !== 0) {
		throw new Error(
			`CLI command failed (exit=${String(result.exitCode)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return JSON.parse(result.stdout) as T;
}

describe("source requirement link commands", () => {
	it("links, lists, and unlinks task associations", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-req-link-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-req-link-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Requirement Link Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = await startRuntimeServer({ cwd: projectPath, env });

			try {
				const runRequirement = (args: string[]) =>
					runCliCommandAndCollectOutput({
						args: ["requirement", ...args, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});

				// Create a requirement to attach links to.
				const created = parseJson<{ ok: boolean; requirement: { id: string } }>(
					await runRequirement(["create", "--title", "Linkable requirement"]),
				);
				expect(created.ok).toBe(true);
				const requirementId = created.requirement.id;
				expect(typeof requirementId).toBe("string");

				// link-task creates a human-made link.
				const linkedAlpha = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement(["link-task", "--id", requirementId, "--task-id", "task-alpha"]),
				);
				expect(linkedAlpha.ok).toBe(true);
				expect(linkedAlpha.link).toMatchObject({ taskId: "task-alpha", source: "human" });
				expect(linkedAlpha.link).not.toHaveProperty("status");

				// Links mirror into linkedTaskIds and appear in linkedTasks.
				const shownAfterAlpha = parseJson<{ ok: boolean; requirement: RequirementRecord }>(
					await runRequirement(["show", "--id", requirementId]),
				);
				expect(shownAfterAlpha.requirement.linkedTaskIds).toContain("task-alpha");
				expect(shownAfterAlpha.requirement.linkedTasks).toEqual([
					expect.objectContaining({ taskId: "task-alpha" }),
				]);

				// A second link to another task.
				const linkedBeta = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement(["link-task", "--id", requirementId, "--task-id", "task-beta"]),
				);
				expect(linkedBeta.ok).toBe(true);
				expect(linkedBeta.link).toMatchObject({ taskId: "task-beta", source: "human" });

				// list surfaces both links, both mirrored into linkedTaskIds.
				const listed = parseJson<{ ok: boolean; requirements: RequirementRecord[] }>(
					await runRequirement(["list"]),
				);
				const listedRequirement = listed.requirements.find((item) => item.id === requirementId);
				expect(listedRequirement).toBeDefined();
				const linkedTaskIdsFromLinks = new Set(
					(listedRequirement?.linkedTasks ?? []).map((link) => link.taskId),
				);
				expect(linkedTaskIdsFromLinks.has("task-alpha")).toBe(true);
				expect(linkedTaskIdsFromLinks.has("task-beta")).toBe(true);
				expect(listedRequirement?.linkedTaskIds).toContain("task-alpha");
				expect(listedRequirement?.linkedTaskIds).toContain("task-beta");

				// Re-linking an existing pair fails (a link either exists or it does not).
				const relink = JSON.parse(
					(await runRequirement(["link-task", "--id", requirementId, "--task-id", "task-alpha"])).stdout,
				) as { ok: boolean; error?: string };
				expect(relink.ok).toBe(false);
				expect(relink.error).toContain("already");

				// unlink-task removes a link.
				const unlinkedAlpha = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement(["unlink-task", "--id", requirementId, "--task-id", "task-alpha"]),
				);
				expect(unlinkedAlpha.ok).toBe(true);
				expect(unlinkedAlpha.link).toMatchObject({ taskId: "task-alpha" });

				const shownAfterUnlink = parseJson<{ ok: boolean; requirement: RequirementRecord }>(
					await runRequirement(["show", "--id", requirementId]),
				);
				expect(shownAfterUnlink.requirement.linkedTaskIds).not.toContain("task-alpha");
				expect(shownAfterUnlink.requirement.linkedTasks).toEqual([
					expect.objectContaining({ taskId: "task-beta" }),
				]);

				// Unlinking a pair that has no link fails.
				const unlinkMissing = JSON.parse(
					(await runRequirement(["unlink-task", "--id", requirementId, "--task-id", "task-alpha"])).stdout,
				) as { ok: boolean; error?: string };
				expect(unlinkMissing.ok).toBe(false);
				expect(unlinkMissing.error).toContain("not found");
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
