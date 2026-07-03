import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { buildSourceCliSpawn } from "../utilities/cli-runtime";

describe("cli compatibility flags", () => {
	it("rejects the removed --agent flag as an unknown option (dropped in P6)", () => {
		// The deprecated root `--agent <id>` (hidden+ignored since P2) was removed in P6 (§8/§9).
		// It is no longer a declared option, so commander reports it as an unknown-option usage
		// error and exits with the §6.2 usage-error code (2). Asserted on a subcommand so the
		// parse fails deterministically before any action runs (the bare-`kanban --help` path
		// would short-circuit to a clean help exit before flagging the unknown option).
		const { command, args } = buildSourceCliSpawn(["task", "list", "--agent", "legacy-alias-value"]);
		const result = spawnSync(command, args, {
			encoding: "utf8",
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown option");
		expect(result.stderr).toContain("--agent");
	});

	it("emits `schema --json` as a single JSON.parse-able envelope (§7.4)", () => {
		const { command, args } = buildSourceCliSpawn(["schema", "--json"]);
		const result = spawnSync(command, args, { encoding: "utf8" });

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
