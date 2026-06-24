import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LinuxSystemdManager } from "../../src/service/platform/linux-systemd-manager";
import type { CommandResult, ServiceConfig } from "../../src/service/service-types";
import { createTempDir } from "../utilities/temp-dir";

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
	return {
		name: "kanban",
		bunPath: "/usr/local/bin/bun",
		scriptPath: "/opt/kanban/dist/cli.js",
		workingDir: "/home/dev/project",
		logDir: "/home/dev/.kanban/logs",
		passcode: true,
		...overrides,
	};
}

interface Recorded {
	command: string;
	args: string[];
}

function makeRunner(responder: (command: string, args: string[]) => CommandResult) {
	const calls: Recorded[] = [];
	const runner = (command: string, args: string[]): CommandResult => {
		calls.push({ command, args });
		return responder(command, args);
	};
	return { calls, runner };
}

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function tempHome(): string {
	const { path, cleanup } = createTempDir("kanban-systemd-");
	cleanups.push(cleanup);
	return path;
}

describe("LinuxSystemdManager.install", () => {
	it("writes the unit file and reloads + enables the service", async () => {
		const homeDir = tempHome();
		const { calls, runner } = makeRunner(() => ok);
		const manager = new LinuxSystemdManager({ homeDir, runner });

		const result = await manager.install(config());

		const unitPath = join(homeDir, ".config", "systemd", "user", "kanban.service");
		expect(existsSync(unitPath)).toBe(true);
		expect(readFileSync(unitPath, "utf8")).toContain("ExecStart=");
		expect(result.ok).toBe(true);
		expect(result.artifactPath).toBe(unitPath);

		const commands = calls.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(commands).toContain("systemctl --user daemon-reload");
		expect(commands).toContain("systemctl --user enable kanban.service");
		// restart (not just start) so a reconfigure applies the new ExecStart to a running unit
		expect(commands).toContain("systemctl --user restart kanban.service");
		// surfaces the linger hint for boot persistence
		expect(result.hints?.some((h) => h.includes("enable-linger"))).toBe(true);
	});

	it("rewrites the unit and restarts when reinstalling with a changed config", async () => {
		const homeDir = tempHome();
		const unitPath = join(homeDir, ".config", "systemd", "user", "kanban.service");

		const first = makeRunner(() => ok);
		await new LinuxSystemdManager({ homeDir, runner: first.runner }).install(config({ port: 7777 }));
		expect(readFileSync(unitPath, "utf8")).toContain("--port 7777");

		const second = makeRunner(() => ok);
		const result = await new LinuxSystemdManager({ homeDir, runner: second.runner }).install(
			config({ host: "0.0.0.0", port: 8888 }),
		);

		// the on-disk unit reflects the NEW host/port
		const unit = readFileSync(unitPath, "utf8");
		expect(unit).toContain("--host 0.0.0.0");
		expect(unit).toContain("--port 8888");
		expect(unit).not.toContain("--port 7777");

		// and the running unit was restarted so the new ExecStart is live
		const commands = second.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(commands).toContain("systemctl --user restart kanban.service");
		expect(result.ok).toBe(true);
		// the message honestly reflects this was a reconfigure, not a first install
		expect(result.message.toLowerCase()).toContain("reconfigured");
	});

	it("does not rewrite or restart when reinstalling with an identical config", async () => {
		const homeDir = tempHome();

		const first = makeRunner(() => ok);
		await new LinuxSystemdManager({ homeDir, runner: first.runner }).install(config({ port: 7777 }));

		const second = makeRunner(() => ok);
		const result = await new LinuxSystemdManager({ homeDir, runner: second.runner }).install(config({ port: 7777 }));

		const commands = second.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(commands).not.toContain("systemctl --user restart kanban.service");
		expect(commands).not.toContain("systemctl --user daemon-reload");
		expect(result.ok).toBe(true);
		// honest: it did not pretend to (re)install — it reports the config was unchanged
		expect(result.message.toLowerCase()).toContain("unchanged");
	});

	it("reports failure when systemctl fails", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner((_command, args) =>
			args.includes("enable") ? { code: 1, stdout: "", stderr: "boom" } : ok,
		);
		const manager = new LinuxSystemdManager({ homeDir, runner });

		const result = await manager.install(config());
		expect(result.ok).toBe(false);
		expect(result.message).toContain("boom");
	});
});

describe("LinuxSystemdManager.status", () => {
	it("reports not installed when the unit file is absent", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner(() => ok);
		const manager = new LinuxSystemdManager({ homeDir, runner });

		const status = await manager.status(config());
		expect(status.installed).toBe(false);
		expect(status.running).toBe(false);
	});

	it("parses is-active / is-enabled when installed", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner(() => ok);
		const manager = new LinuxSystemdManager({ homeDir, runner });
		await manager.install(config());

		const probe = makeRunner((_command, args) => {
			if (args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
			if (args.includes("is-enabled")) return { code: 0, stdout: "enabled\n", stderr: "" };
			if (args.includes("show")) return { code: 0, stdout: "1234\n", stderr: "" };
			return ok;
		});
		const probed = new LinuxSystemdManager({ homeDir, runner: probe.runner });
		const status = await probed.status(config());
		expect(status.installed).toBe(true);
		expect(status.running).toBe(true);
		expect(status.enabled).toBe(true);
		expect(status.pid).toBe(1234);
	});
});

describe("LinuxSystemdManager.uninstall", () => {
	it("disables, removes the unit file and reloads", async () => {
		const homeDir = tempHome();
		const { runner } = makeRunner(() => ok);
		const manager = new LinuxSystemdManager({ homeDir, runner });
		await manager.install(config());

		const result = await manager.uninstall(config());
		const unitPath = join(homeDir, ".config", "systemd", "user", "kanban.service");
		expect(existsSync(unitPath)).toBe(false);
		expect(result.ok).toBe(true);
	});
});
