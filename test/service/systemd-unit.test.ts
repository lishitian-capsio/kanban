import { describe, expect, it } from "vitest";

import { buildSystemdUnit } from "../../src/service/platform/systemd-unit";
import type { ServiceConfig } from "../../src/service/service-types";

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

describe("buildSystemdUnit", () => {
	it("renders a [Service] ExecStart with bun, script and the safety flags", () => {
		const unit = buildSystemdUnit(config());
		expect(unit).toContain("[Service]");
		expect(unit).toMatch(/ExecStart=.*\/usr\/local\/bin\/bun.*dist\/cli\.js/);
		expect(unit).toContain("--skip-shutdown-cleanup");
		expect(unit).toContain("--no-open");
		// --no-env-file (before the script) keeps a repo .env out of the daemon env.
		expect(unit).toMatch(/ExecStart=.*bun.*--no-env-file.*dist\/cli\.js/);
	});

	it("sets the working directory and restart policy", () => {
		const unit = buildSystemdUnit(config());
		expect(unit).toContain("WorkingDirectory=/home/dev/project");
		expect(unit).toContain("Restart=on-failure");
	});

	it("enables at login via the default.target install section", () => {
		const unit = buildSystemdUnit(config());
		expect(unit).toContain("[Install]");
		expect(unit).toContain("WantedBy=default.target");
	});

	it("quotes paths that contain spaces in ExecStart", () => {
		const unit = buildSystemdUnit(config({ scriptPath: "/opt/my kanban/dist/cli.js" }));
		expect(unit).toContain('"/opt/my kanban/dist/cli.js"');
	});
});
