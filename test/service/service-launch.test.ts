import { describe, expect, it } from "vitest";

import { buildServiceCommand, buildServiceLaunchArgs } from "../../src/service/service-launch";
import type { ServiceConfig } from "../../src/service/service-types";

function baseConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
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

describe("buildServiceLaunchArgs", () => {
	it("always includes --skip-shutdown-cleanup and --no-open", () => {
		const args = buildServiceLaunchArgs(baseConfig());
		expect(args).toContain("--skip-shutdown-cleanup");
		expect(args).toContain("--no-open");
	});

	it("does not include --host/--port/--no-passcode when not configured", () => {
		const args = buildServiceLaunchArgs(baseConfig());
		expect(args).not.toContain("--host");
		expect(args).not.toContain("--port");
		expect(args).not.toContain("--no-passcode");
	});

	it("passes through --host and --port when configured", () => {
		const args = buildServiceLaunchArgs(baseConfig({ host: "0.0.0.0", port: 4000 }));
		expect(args).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--port", "4000"]));
		// --port value is a string
		const portIndex = args.indexOf("--port");
		expect(args[portIndex + 1]).toBe("4000");
	});

	it("adds --no-passcode only when passcode is disabled", () => {
		expect(buildServiceLaunchArgs(baseConfig({ passcode: false }))).toContain("--no-passcode");
		expect(buildServiceLaunchArgs(baseConfig({ passcode: true }))).not.toContain("--no-passcode");
	});

	it("appends extra args verbatim at the end", () => {
		const args = buildServiceLaunchArgs(baseConfig({ extraArgs: ["--https", "--cert", "/x.pem"] }));
		expect(args.slice(-3)).toEqual(["--https", "--cert", "/x.pem"]);
	});
});

describe("buildServiceCommand", () => {
	it("prefixes the bun executable and the cli script path", () => {
		const command = buildServiceCommand(baseConfig());
		expect(command[0]).toBe("/usr/local/bin/bun");
		expect(command[1]).toBe("/opt/kanban/dist/cli.js");
		expect(command.slice(2)).toEqual(buildServiceLaunchArgs(baseConfig()));
	});
});
