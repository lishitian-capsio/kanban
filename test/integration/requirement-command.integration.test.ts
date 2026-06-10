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
	status: "proposed" | "confirmed";
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
	it("links, lists, confirms, rejects, and unlinks task associations", { timeout: 60_000 }, async () => {
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

				// link-task defaults to a confirmed, human-made link.
				const linkedAlpha = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement(["link-task", "--id", requirementId, "--task-id", "task-alpha"]),
				);
				expect(linkedAlpha.ok).toBe(true);
				expect(linkedAlpha.link).toMatchObject({
					taskId: "task-alpha",
					status: "confirmed",
					source: "human",
				});

				// Confirmed links mirror into linkedTaskIds and appear in linkedTasks.
				const shownAfterAlpha = parseJson<{ ok: boolean; requirement: RequirementRecord }>(
					await runRequirement(["show", "--id", requirementId]),
				);
				expect(shownAfterAlpha.requirement.linkedTaskIds).toContain("task-alpha");
				expect(shownAfterAlpha.requirement.linkedTasks).toEqual([
					expect.objectContaining({ taskId: "task-alpha", status: "confirmed" }),
				]);

				// --state proposed records an agent-style suggestion (here made by a human).
				const linkedBeta = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement([
						"link-task",
						"--id",
						requirementId,
						"--task-id",
						"task-beta",
						"--state",
						"proposed",
					]),
				);
				expect(linkedBeta.ok).toBe(true);
				expect(linkedBeta.link).toMatchObject({ taskId: "task-beta", status: "proposed" });

				// list surfaces both links with their states.
				const listed = parseJson<{ ok: boolean; requirements: RequirementRecord[] }>(
					await runRequirement(["list"]),
				);
				const listedRequirement = listed.requirements.find((item) => item.id === requirementId);
				expect(listedRequirement).toBeDefined();
				const statusByTask = new Map(
					(listedRequirement?.linkedTasks ?? []).map((link) => [link.taskId, link.status]),
				);
				expect(statusByTask.get("task-alpha")).toBe("confirmed");
				expect(statusByTask.get("task-beta")).toBe("proposed");
				// proposed links are not mirrored into linkedTaskIds.
				expect(listedRequirement?.linkedTaskIds).not.toContain("task-beta");

				// reject-link only applies to proposed links: rejecting a confirmed one fails.
				const rejectConfirmed = JSON.parse(
					(await runRequirement(["reject-link", "--id", requirementId, "--task-id", "task-alpha"])).stdout,
				) as { ok: boolean; error?: string };
				expect(rejectConfirmed.ok).toBe(false);
				expect(rejectConfirmed.error).toContain("confirmed");

				// confirm-link flips the proposed beta link to confirmed.
				const confirmedBeta = parseJson<{ ok: boolean; link: LinkRecord }>(
					await runRequirement(["confirm-link", "--id", requirementId, "--task-id", "task-beta"]),
				);
				expect(confirmedBeta.ok).toBe(true);
				expect(confirmedBeta.link).toMatchObject({ taskId: "task-beta", status: "confirmed" });

				// unlink-task removes a confirmed link.
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
					expect.objectContaining({ taskId: "task-beta", status: "confirmed" }),
				]);

				// Guard: a proposed link cannot be unlinked; the data layer steers to reject.
				parseJson<{ ok: boolean }>(
					await runRequirement([
						"link-task",
						"--id",
						requirementId,
						"--task-id",
						"task-gamma",
						"--state",
						"proposed",
					]),
				);
				const unlinkProposed = JSON.parse(
					(await runRequirement(["unlink-task", "--id", requirementId, "--task-id", "task-gamma"])).stdout,
				) as { ok: boolean; error?: string };
				expect(unlinkProposed.ok).toBe(false);
				expect(unlinkProposed.error).toContain("reject");
			} finally {
				await stopRuntimeServer(serverProcess);
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
