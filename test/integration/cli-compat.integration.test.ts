import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

describe("cli compatibility flags", () => {
	it("accepts the deprecated --agent flag as a no-op", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--agent",
				"legacy-alias-value",
				"--help",
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).not.toContain("--agent");
		expect(result.stdout).not.toContain("Agent IDs:");
	});

	it("emits `schema --json` as a single JSON.parse-able envelope (§7.4)", () => {
		const result = spawnSync(
			process.execPath,
			["--import", resolveTsxLoaderImportSpecifier(), resolve(process.cwd(), "src/cli.ts"), "schema", "--json"],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		// Exactly one JSON document on stdout — nothing else (§7.3).
		const envelope = JSON.parse(result.stdout) as {
			ok: boolean;
			command: string;
			data: { commands: Array<{ id: string }>; errorCodes: unknown[] };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.command).toBe("schema");
		const ids = envelope.data.commands.map((command) => command.id);
		expect(ids).toContain("task.create");
		expect(ids).toContain("db.query");
		expect(envelope.data.errorCodes.length).toBeGreaterThan(0);
	});
});
