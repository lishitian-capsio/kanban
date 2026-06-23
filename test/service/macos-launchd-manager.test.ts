import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MacosLaunchdManager } from "../../src/service/platform/macos-launchd-manager";
import type { CommandResult, ServiceConfig } from "../../src/service/service-types";
import { createTempDir } from "../utilities/temp-dir";

function config(homeDir: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
	return {
		name: "kanban",
		bunPath: "/opt/homebrew/bin/bun",
		scriptPath: "/opt/kanban/dist/cli.js",
		workingDir: "/Users/dev/project",
		logDir: join(homeDir, ".kanban", "logs"),
		passcode: true,
		...overrides,
	};
}

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});
function tempHome(): string {
	const { path, cleanup } = createTempDir("kanban-launchd-");
	cleanups.push(cleanup);
	return path;
}
function makeRunner(responder: (command: string, args: string[]) => CommandResult) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner = (command: string, args: string[]): CommandResult => {
		calls.push({ command, args });
		return responder(command, args);
	};
	return { calls, runner };
}

const plistPath = (homeDir: string) => join(homeDir, "Library", "LaunchAgents", "ai.capsio.kanban.plist");

describe("MacosLaunchdManager.install", () => {
	it("writes the plist and loads it with launchctl", async () => {
		const homeDir = tempHome();
		const { calls, runner } = makeRunner(() => ok);
		const manager = new MacosLaunchdManager({ homeDir, runner });

		const result = await manager.install(config(homeDir));
		expect(existsSync(plistPath(homeDir))).toBe(true);
		expect(result.ok).toBe(true);
		expect(result.artifactPath).toBe(plistPath(homeDir));

		const commands = calls.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(commands).toContain(`launchctl load -w ${plistPath(homeDir)}`);
	});

	it("creates the log directory", async () => {
		const homeDir = tempHome();
		const logDir = join(homeDir, "logs");
		const { runner } = makeRunner(() => ok);
		const manager = new MacosLaunchdManager({ homeDir, runner });
		await manager.install(config(homeDir, { logDir }));
		expect(existsSync(logDir)).toBe(true);
	});
});

describe("MacosLaunchdManager.status", () => {
	it("reports not installed when the plist is absent", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner(() => ok);
		const manager = new MacosLaunchdManager({ homeDir, runner });
		const status = await manager.status(config(homeDir));
		expect(status.installed).toBe(false);
	});

	it("parses the PID from launchctl list output when running", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner(() => ok);
		await new MacosLaunchdManager({ homeDir, runner }).install(config(homeDir));

		const probe = makeRunner((_c, args) =>
			args.includes("list")
				? { code: 0, stdout: '{\n\t"PID" = 4321;\n\t"Label" = "ai.capsio.kanban";\n};\n', stderr: "" }
				: ok,
		);
		const status = await new MacosLaunchdManager({ homeDir, runner: probe.runner }).status(config(homeDir));
		expect(status.installed).toBe(true);
		expect(status.running).toBe(true);
		expect(status.pid).toBe(4321);
	});
});

describe("MacosLaunchdManager.uninstall", () => {
	it("unloads and removes the plist", async () => {
		const homeDir = tempHome();
		const { calls, runner } = makeRunner(() => ok);
		const manager = new MacosLaunchdManager({ homeDir, runner });
		await manager.install(config(homeDir));

		const result = await manager.uninstall(config(homeDir));
		expect(existsSync(plistPath(homeDir))).toBe(false);
		expect(result.ok).toBe(true);
		const commands = calls.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(commands).toContain(`launchctl unload -w ${plistPath(homeDir)}`);
	});
});
