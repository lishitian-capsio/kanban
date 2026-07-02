import { describe, expect, it } from "vitest";

import { buildLaunchdLabel, buildLaunchdPlist } from "../../src/service/platform/launchd-plist";
import type { ServiceConfig } from "../../src/service/service-types";

function config(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
	return {
		name: "kanban",
		bunPath: "/opt/homebrew/bin/bun",
		scriptPath: "/opt/kanban/dist/cli.js",
		workingDir: "/Users/dev/project",
		logDir: "/Users/dev/.kanban/logs",
		passcode: true,
		...overrides,
	};
}

describe("buildLaunchdLabel", () => {
	it("uses a reverse-dns label derived from the service name", () => {
		expect(buildLaunchdLabel("kanban")).toBe("ai.capsio.kanban");
		expect(buildLaunchdLabel("kanban-staging")).toBe("ai.capsio.kanban-staging");
	});
});

describe("buildLaunchdPlist", () => {
	it("lists bun, the script and safety flags as ProgramArguments", () => {
		const plist = buildLaunchdPlist(config());
		expect(plist).toContain("<key>ProgramArguments</key>");
		expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
		expect(plist).toContain("<string>/opt/kanban/dist/cli.js</string>");
		expect(plist).toContain("<string>--skip-shutdown-cleanup</string>");
		expect(plist).toContain("<string>--no-open</string>");
		expect(plist).toContain("<string>--no-env-file</string>");
	});

	it("sets RunAtLoad and KeepAlive so it starts at login and respawns", () => {
		const plist = buildLaunchdPlist(config());
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
	});

	it("points stdout/stderr at the log directory", () => {
		const plist = buildLaunchdPlist(config());
		expect(plist).toContain("<string>/Users/dev/.kanban/logs/kanban.out.log</string>");
		expect(plist).toContain("<string>/Users/dev/.kanban/logs/kanban.err.log</string>");
	});

	it("embeds the reverse-dns label", () => {
		const plist = buildLaunchdPlist(config());
		expect(plist).toContain("<key>Label</key>");
		expect(plist).toContain("<string>ai.capsio.kanban</string>");
	});

	it("xml-escapes values containing special characters", () => {
		const plist = buildLaunchdPlist(config({ workingDir: "/Users/dev/a & b" }));
		expect(plist).toContain("/Users/dev/a &amp; b");
		expect(plist).not.toContain("/Users/dev/a & b");
	});
});
