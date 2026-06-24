import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitAll, initGitRepository, runCliCommandAndCollectOutput } from "../utilities/cli-runtime";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface VaultTypeIndexEntry {
	type: string;
	label: string;
	description?: string;
	icon?: string;
	statusEnum?: string[];
}

interface VaultTypeDefinitionRecord extends VaultTypeIndexEntry {
	slugField: string;
	defaultFrontmatter?: Record<string, unknown>;
	body: string;
}

interface SuccessEnvelope<T> {
	schemaVersion: string;
	ok: true;
	command: string;
	data: T;
}

// Parse the machine envelope (design doc §4.2) and return the unwrapped `data` payload.
function parseJson<T>(result: { stdout: string; stderr: string; exitCode: number | null }): T {
	if (result.exitCode !== 0) {
		throw new Error(
			`CLI command failed (exit=${String(result.exitCode)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	const envelope = JSON.parse(result.stdout) as SuccessEnvelope<T>;
	expect(envelope.schemaVersion).toBe("2");
	expect(envelope.ok).toBe(true);
	return envelope.data;
}

describe("vault type commands", () => {
	it(
		"list returns a body-free index and show returns the full definition (progressive disclosure)",
		{ timeout: 60_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-vault-type-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-vault-type-");

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Vault Type Command Test\n", "utf8");
				commitAll(projectPath, "init");

				const env = createGitTestEnv({ HOME: homeDir, USERPROFILE: homeDir });

				// Run from the (non-project) home dir to prove --project-path routing works.
				const runVault = (args: string[]) =>
					runCliCommandAndCollectOutput({
						args: ["vault", ...args, "--project-path", projectPath],
						cwd: homeDir,
						env,
					});

				// list — light index of the seeded types, NO body (the skill "name/description" tier).
				const listed = parseJson<{
					workspacePath: string;
					types: VaultTypeIndexEntry[];
					count: number;
				}>(await runVault(["type", "list"]));
				// --project-path resolved to the project workspace, not the cwd (home dir).
				expect(listed.workspacePath).toContain("kanban-project-vault-type-");
				expect(listed.count).toBe(4);
				expect(listed.types.map((entry) => entry.type).sort()).toEqual([
					"customer",
					"decision",
					"note",
					"requirement",
				]);

				const requirementIndex = listed.types.find((entry) => entry.type === "requirement");
				expect(requirementIndex).toBeDefined();
				expect(requirementIndex?.label).toBe("Requirement");
				expect(requirementIndex?.description).toContain("customer-facing problem statement");
				expect(requirementIndex?.statusEnum).toEqual(["proposed", "clarified", "parked", "invalid"]);
				// The index tier never carries the authoring prompt.
				expect(requirementIndex).not.toHaveProperty("body");

				// show — the full definition including the authoring prompt (the skill "loaded" tier).
				const shown = parseJson<{
					workspacePath: string;
					definition: VaultTypeDefinitionRecord;
				}>(await runVault(["type", "show", "--type", "requirement"]));
				expect(shown.definition.type).toBe("requirement");
				expect(shown.definition.label).toBe("Requirement");
				expect(shown.definition.slugField).toBe("title");
				expect(shown.definition.statusEnum).toEqual(["proposed", "clarified", "parked", "invalid"]);
				expect(shown.definition.defaultFrontmatter).toEqual({ status: "proposed", priority: "medium" });
				// The full authoring prompt body is present.
				expect(shown.definition.body).toContain("How to author a Requirement");

				// show on an unknown type fails cleanly (permissive engine → CLI surfaces "not found").
				const missing = JSON.parse((await runVault(["type", "show", "--type", "spec"])).stdout) as {
					ok: boolean;
					error?: { code: string; message: string };
					errorMessage?: string;
				};
				expect(missing.ok).toBe(false);
				expect(missing.error?.message).toContain("not found");
				// The legacy `errorMessage` string mirror was removed in P6 (§8/§9).
				expect(missing.errorMessage).toBeUndefined();
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);
});
