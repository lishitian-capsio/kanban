import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CleanupHookPaths, cleanupAgentHooks } from "../../src/commands/hooks";

describe("cleanupAgentHooks", () => {
	let sandbox: string;
	let paths: CleanupHookPaths;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), "hooks-cleanup-test-"));
		paths = {
			claudeSettingsPath: join(sandbox, ".claude", "settings.json"),
			hooksRoot: join(sandbox, "hooks"),
			kiroConfigPath: join(sandbox, ".kiro", "agents", "kanban.json"),
		};
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	it("reports skipped when no hook configs exist", () => {
		const results = cleanupAgentHooks(paths);
		expect(results.every((r) => r.status === "skipped")).toBe(true);
	});

	it("removes hooks key from Claude settings and preserves other fields", () => {
		mkdirSync(join(sandbox, ".claude"), { recursive: true });
		const settings = {
			permissions: { defaultMode: "auto" },
			hooks: { Stop: [{ hooks: [{ type: "command", command: "kanban hooks ingest" }] }] },
			someOtherKey: "value",
		};
		writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings, null, 2));

		const results = cleanupAgentHooks(paths);

		const claudeResult = results.find((r) => r.target.includes("Claude Code"));
		expect(claudeResult?.status).toBe("cleaned");

		const remaining = JSON.parse(readFileSync(paths.claudeSettingsPath, "utf8"));
		expect(remaining.hooks).toBeUndefined();
		expect(remaining.permissions).toEqual({ defaultMode: "auto" });
		expect(remaining.someOtherKey).toBe("value");
	});

	it("skips Claude settings when hooks key is absent", () => {
		mkdirSync(join(sandbox, ".claude"), { recursive: true });
		writeFileSync(paths.claudeSettingsPath, JSON.stringify({ permissions: {} }));

		const results = cleanupAgentHooks(paths);

		const claudeResult = results.find((r) => r.target.includes("Claude Code"));
		expect(claudeResult?.status).toBe("skipped");
	});

	it("removes kanban-managed agent hook directories", () => {
		for (const agent of ["gemini", "droid", "opencode"]) {
			const dir = join(paths.hooksRoot, agent);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "settings.json"), "{}");
		}

		const results = cleanupAgentHooks(paths);

		for (const agent of ["gemini", "droid", "opencode"]) {
			const agentResult = results.find((r) => r.target.startsWith(agent));
			expect(agentResult?.status).toBe("removed");
			expect(existsSync(join(paths.hooksRoot, agent))).toBe(false);
		}
	});

	it("removes Kiro agent config", () => {
		mkdirSync(join(sandbox, ".kiro", "agents"), { recursive: true });
		writeFileSync(paths.kiroConfigPath, JSON.stringify({ name: "kanban" }));

		const results = cleanupAgentHooks(paths);

		const kiroResult = results.find((r) => r.target.includes("Kiro"));
		expect(kiroResult?.status).toBe("removed");
		expect(existsSync(paths.kiroConfigPath)).toBe(false);
	});
});
