import { describe, expect, it } from "vitest";

import { buildServiceConfig, type ResolvedServicePaths } from "../../src/service/service-config";

const resolved: ResolvedServicePaths = {
	bunPath: "/usr/local/bin/bun",
	scriptPath: "/opt/kanban/dist/cli.js",
	workingDir: "/home/dev/project",
	logDir: "/home/dev/.kanban/logs",
};

describe("buildServiceConfig", () => {
	it("defaults the name to kanban and keeps passcode enabled", () => {
		const config = buildServiceConfig({}, resolved);
		expect(config.name).toBe("kanban");
		expect(config.passcode).toBe(true);
		expect(config.bunPath).toBe("/usr/local/bin/bun");
		expect(config.scriptPath).toBe("/opt/kanban/dist/cli.js");
		expect(config.workingDir).toBe("/home/dev/project");
		expect(config.logDir).toBe("/home/dev/.kanban/logs");
	});

	it("maps --name, --host, --port and --no-passcode", () => {
		const config = buildServiceConfig(
			{ name: "kanban-staging", host: "0.0.0.0", port: 4100, noPasscode: true },
			resolved,
		);
		expect(config.name).toBe("kanban-staging");
		expect(config.host).toBe("0.0.0.0");
		expect(config.port).toBe(4100);
		expect(config.passcode).toBe(false);
	});

	it("passes extra args through", () => {
		const config = buildServiceConfig({ extraArgs: ["--https"] }, resolved);
		expect(config.extraArgs).toEqual(["--https"]);
	});
});
