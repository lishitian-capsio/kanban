import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The built `kanban` binary's shebang must disable Bun's default `.env`
 * auto-loading. When `kanban` runs inside an arbitrary user repo or task
 * worktree, a stray `.env` in the cwd must NOT be injected into the runtime's
 * environment (KANBAN_*, proxy vars, credential-file paths). Kanban reads none
 * of its own config from `.env`, so this is pure hardening.
 *
 * We assert against the build source (not a built artifact) so the guard holds
 * without requiring `npm run build` first.
 */
const buildScript = readFileSync(
	fileURLToPath(new URL("../../scripts/build.mjs", import.meta.url)),
	"utf8",
);

describe("dist/cli.js shebang", () => {
	it("passes --no-env-file to bun via `env -S` so a repo .env can't pollute the runtime", () => {
		expect(buildScript).toContain('"#!/usr/bin/env -S bun --no-env-file"');
		// Guard against a silent revert to the flag-less shebang.
		expect(buildScript).not.toContain('"#!/usr/bin/env bun"');
	});
});
