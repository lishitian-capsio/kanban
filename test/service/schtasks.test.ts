import { describe, expect, it } from "vitest";

import {
	buildSchtasksCreateArgs,
	buildSchtasksDeleteArgs,
	buildSchtasksEndArgs,
	buildSchtasksQueryArgs,
	buildSchtasksRunArgs,
	buildSchtasksTaskRunString,
} from "../../src/service/platform/schtasks";
import type { ServiceConfig } from "../../src/service/service-types";

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

describe("buildSchtasksTaskRunString", () => {
	it("quotes the bun and script paths and includes the safety flags", () => {
		const tr = buildSchtasksTaskRunString(config());
		expect(tr).toContain('"C:\\Program Files\\bun\\bun.exe"');
		expect(tr).toContain('"C:\\kanban\\dist\\cli.js"');
		expect(tr).toContain("--skip-shutdown-cleanup");
		expect(tr).toContain("--no-open");
	});
});

describe("buildSchtasksCreateArgs", () => {
	it("creates an at-logon task with force-overwrite", () => {
		const args = buildSchtasksCreateArgs(config());
		expect(args).toEqual(expect.arrayContaining(["/Create", "/TN", "kanban", "/SC", "ONLOGON", "/F"]));
		const trIndex = args.indexOf("/TR");
		expect(trIndex).toBeGreaterThanOrEqual(0);
		expect(args[trIndex + 1]).toBe(buildSchtasksTaskRunString(config()));
	});
});

describe("schtasks lifecycle arg builders", () => {
	it("delete forces removal by task name", () => {
		expect(buildSchtasksDeleteArgs("kanban")).toEqual(["/Delete", "/TN", "kanban", "/F"]);
	});
	it("run starts the task by name", () => {
		expect(buildSchtasksRunArgs("kanban")).toEqual(["/Run", "/TN", "kanban"]);
	});
	it("end stops the task by name", () => {
		expect(buildSchtasksEndArgs("kanban")).toEqual(["/End", "/TN", "kanban"]);
	});
	it("query asks for list format by name", () => {
		expect(buildSchtasksQueryArgs("kanban")).toEqual(["/Query", "/TN", "kanban", "/FO", "LIST", "/V"]);
	});
});
