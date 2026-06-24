import { describe, expect, it } from "vitest";

import { WindowsSchtasksManager } from "../../src/service/platform/windows-schtasks-manager";
import type { CommandResult, ServiceConfig } from "../../src/service/service-types";

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
	return {
		name: "kanban",
		bunPath: "C:\\Program Files\\bun\\bun.exe",
		scriptPath: "C:\\kanban\\dist\\cli.js",
		workingDir: "C:\\projects\\app",
		logDir: "C:\\Users\\dev\\.kanban\\logs",
		passcode: true,
		...overrides,
	};
}

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };

function makeRunner(responder: (command: string, args: string[]) => CommandResult) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const runner = (command: string, args: string[]): CommandResult => {
		calls.push({ command, args });
		return responder(command, args);
	};
	return { calls, runner };
}

describe("WindowsSchtasksManager.install", () => {
	it("creates a scheduled task via schtasks", async () => {
		// Fresh install: /Query reports not-installed, so this is a first-time create.
		const { calls, runner } = makeRunner((_command, args) =>
			args.includes("/Query") ? { code: 1, stdout: "", stderr: "ERROR: cannot find" } : ok,
		);
		const result = await new WindowsSchtasksManager({ runner }).install(config());
		expect(result.ok).toBe(true);
		const create = calls.find((c) => c.args.includes("/Create"));
		expect(create?.command).toBe("schtasks");
		expect(create?.args).toContain("ONLOGON");
	});

	it("recreates the task and restarts it when reinstalling over a running task", async () => {
		// /Query succeeds (already installed) and reports the task as Running.
		const { calls, runner } = makeRunner((_command, args) =>
			args.includes("/Query")
				? { code: 0, stdout: "Status: Running\r\nScheduled Task State: Enabled\r\n", stderr: "" }
				: ok,
		);
		const result = await new WindowsSchtasksManager({ runner }).install(config());

		const verbs = calls.flatMap((c) => c.args).filter((a) => ["/Create", "/End", "/Run"].includes(a));
		// recreate (force-overwrite), then bounce the running instance so the new command is live
		expect(verbs).toEqual(["/Create", "/End", "/Run"]);
		expect(result.ok).toBe(true);
		// honest: it reports a reinstall, not a first-time install
		expect(result.message.toLowerCase()).toContain("reinstall");
	});

	it("recreates without restarting when reinstalling over a non-running task", async () => {
		const { calls, runner } = makeRunner((_command, args) =>
			args.includes("/Query")
				? { code: 0, stdout: "Status: Ready\r\nScheduled Task State: Enabled\r\n", stderr: "" }
				: ok,
		);
		const result = await new WindowsSchtasksManager({ runner }).install(config());

		const verbs = calls.flatMap((c) => c.args).filter((a) => ["/Create", "/End", "/Run"].includes(a));
		expect(verbs).toEqual(["/Create"]);
		expect(result.ok).toBe(true);
		expect(result.message.toLowerCase()).toContain("reinstall");
	});

	it("reports failure when schtasks create fails", async () => {
		const { runner } = makeRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." }));
		const result = await new WindowsSchtasksManager({ runner }).install(config());
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Access is denied");
	});
});

describe("WindowsSchtasksManager.status", () => {
	it("reports not installed when the query returns nonzero", async () => {
		const { runner } = makeRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: cannot find" }));
		const status = await new WindowsSchtasksManager({ runner }).status(config());
		expect(status.installed).toBe(false);
	});

	it("parses Running status from the verbose query output", async () => {
		const { runner } = makeRunner(() => ({
			code: 0,
			stdout: "TaskName: \\kanban\r\nStatus: Running\r\nScheduled Task State: Enabled\r\n",
			stderr: "",
		}));
		const status = await new WindowsSchtasksManager({ runner }).status(config());
		expect(status.installed).toBe(true);
		expect(status.running).toBe(true);
		expect(status.enabled).toBe(true);
	});

	it("treats a Ready task as installed but not running", async () => {
		const { runner } = makeRunner(() => ({
			code: 0,
			stdout: "Status: Ready\r\nScheduled Task State: Enabled\r\n",
			stderr: "",
		}));
		const status = await new WindowsSchtasksManager({ runner }).status(config());
		expect(status.installed).toBe(true);
		expect(status.running).toBe(false);
	});
});

describe("WindowsSchtasksManager lifecycle", () => {
	it("stop ends the task and restart ends then runs", async () => {
		const stop = makeRunner(() => ok);
		await new WindowsSchtasksManager({ runner: stop.runner }).stop(config());
		expect(stop.calls.at(-1)?.args).toContain("/End");

		const restart = makeRunner(() => ok);
		await new WindowsSchtasksManager({ runner: restart.runner }).restart(config());
		const verbs = restart.calls.flatMap((c) => c.args).filter((a) => a === "/End" || a === "/Run");
		expect(verbs).toEqual(["/End", "/Run"]);
	});

	it("uninstall deletes the task", async () => {
		const { calls, runner } = makeRunner(() => ok);
		const result = await new WindowsSchtasksManager({ runner }).uninstall(config());
		expect(result.ok).toBe(true);
		expect(calls.at(-1)?.args).toContain("/Delete");
	});
});
