import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { commitAll, initGitRepository, runCliCommandAndCollectOutput, runGit } from "../utilities/cli-runtime";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

interface VaultDocumentRecord {
	id: string;
	type: string;
	title: string;
	body: string;
	frontmatter: Record<string, unknown>;
	relativePath: string;
	createdAt: number;
	updatedAt: number;
}

function parseJson<T>(result: { stdout: string; stderr: string; exitCode: number | null }): T {
	if (result.exitCode !== 0) {
		throw new Error(
			`CLI command failed (exit=${String(result.exitCode)}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return JSON.parse(result.stdout) as T;
}

describe("vault doc commands", () => {
	it(
		"round-trips create/list/show/update/delete on disk with real .md files and git diffs (no runtime)",
		{ timeout: 60_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-vault-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-vault-");

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Vault Command Test\n", "utf8");
				commitAll(projectPath, "init");

				const env = createGitTestEnv({ HOME: homeDir, USERPROFILE: homeDir });

				const runVault = (args: string[]) =>
					runCliCommandAndCollectOutput({
						args: ["vault", ...args, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});

				// create — operating directly on disk, no runtime started.
				const created = parseJson<{ ok: boolean; document: VaultDocumentRecord }>(
					await runVault([
						"doc",
						"create",
						"--type",
						"requirement",
						"--title",
						"Rate-limit login endpoint",
						"--body",
						"Logins must be throttled per account.",
						"--set",
						"priority=high",
					]),
				);
				expect(created.ok).toBe(true);
				const doc = created.document;
				expect(doc.type).toBe("requirement");
				expect(doc.title).toBe("Rate-limit login endpoint");
				expect(doc.body).toBe("Logins must be throttled per account.");
				// Type-default + explicit override both land in frontmatter.
				expect(doc.frontmatter.status).toBe("proposed");
				expect(doc.frontmatter.priority).toBe("high");
				expect(doc.relativePath).toMatch(/^\.kanban\/.*docs\/requirement\/rate-limit-login-endpoint-.*\.md$/);

				// A real .md file landed on disk at the reported path.
				const absolutePath = join(projectPath, doc.relativePath);
				const onDisk = readFileSync(absolutePath, "utf8");
				expect(onDisk).toContain(`_id: ${doc.id}`);
				expect(onDisk).toContain("type: requirement");
				expect(onDisk).toContain("status: proposed");
				expect(onDisk).toContain("priority: high");
				expect(onDisk).toContain("Logins must be throttled per account.");

				// git sees a meaningful untracked addition of the doc file.
				const statusAfterCreate = runGit(projectPath, ["status", "--porcelain", "--", doc.relativePath]);
				expect(statusAfterCreate).toContain("?? ");
				expect(statusAfterCreate).toContain("docs/requirement/");

				// Commit it so a later edit produces a content diff (not an add).
				commitAll(projectPath, "add requirement doc");

				// list — finds it, filtered by type.
				const listed = parseJson<{ ok: boolean; documents: VaultDocumentRecord[]; count: number }>(
					await runVault(["doc", "list", "--type", "requirement"]),
				);
				expect(listed.count).toBe(1);
				expect(listed.documents[0].id).toBe(doc.id);

				// list with a non-matching type filter returns nothing.
				const listedOther = parseJson<{ ok: boolean; count: number }>(
					await runVault(["doc", "list", "--type", "customer"]),
				);
				expect(listedOther.count).toBe(0);

				// show — returns the same content.
				const shown = parseJson<{ ok: boolean; document: VaultDocumentRecord }>(
					await runVault(["doc", "show", "--id", doc.id]),
				);
				expect(shown.document.title).toBe("Rate-limit login endpoint");
				expect(shown.document.body).toBe("Logins must be throttled per account.");

				// update — change body + a frontmatter field; the file stays the same path.
				const updated = parseJson<{ ok: boolean; document: VaultDocumentRecord }>(
					await runVault([
						"doc",
						"update",
						"--id",
						doc.id,
						"--body",
						"Logins must be throttled per account and IP.",
						"--set",
						"status=clarified",
					]),
				);
				expect(updated.document.body).toBe("Logins must be throttled per account and IP.");
				expect(updated.document.frontmatter.status).toBe("clarified");
				expect(updated.document.relativePath).toBe(doc.relativePath);

				// git diff shows a meaningful content change to the committed doc file.
				const diff = runGit(projectPath, ["diff", "--", doc.relativePath]);
				expect(diff).toContain("-status: proposed");
				expect(diff).toContain("+status: clarified");
				expect(diff).toContain("+Logins must be throttled per account and IP.");

				// update with a new title — re-slugs the filename, recording a git rename.
				const renamed = parseJson<{ ok: boolean; document: VaultDocumentRecord }>(
					await runVault(["doc", "update", "--id", doc.id, "--title", "Throttle login attempts"]),
				);
				expect(renamed.document.relativePath).not.toBe(doc.relativePath);
				expect(renamed.document.relativePath).toContain("throttle-login-attempts-");
				// Old slug file is gone, new one exists; same id retained.
				const docDir = join(projectPath, doc.relativePath, "..");
				const files = readdirSync(docDir);
				expect(files.some((name) => name.includes("throttle-login-attempts-"))).toBe(true);
				expect(files.some((name) => name.includes("rate-limit-login-endpoint-"))).toBe(false);
				expect(renamed.document.id).toBe(doc.id);

				// delete — removes the file from disk.
				const deleted = parseJson<{ ok: boolean; deleted: boolean }>(
					await runVault(["doc", "delete", "--id", doc.id]),
				);
				expect(deleted.deleted).toBe(true);
				const afterDelete = parseJson<{ ok: boolean; count: number }>(await runVault(["doc", "list"]));
				expect(afterDelete.count).toBe(0);

				// Deleting again fails cleanly (not found).
				const deleteMissing = JSON.parse((await runVault(["doc", "delete", "--id", doc.id])).stdout) as {
					ok: boolean;
					error?: string;
				};
				expect(deleteMissing.ok).toBe(false);
				expect(deleteMissing.error).toContain("not found");
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);
});
