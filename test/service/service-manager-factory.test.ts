import { describe, expect, it } from "vitest";

import { LinuxSystemdManager } from "../../src/service/platform/linux-systemd-manager";
import { MacosLaunchdManager } from "../../src/service/platform/macos-launchd-manager";
import { WindowsSchtasksManager } from "../../src/service/platform/windows-schtasks-manager";
import { createServiceManager, UnsupportedPlatformError } from "../../src/service/service-manager-factory";

describe("createServiceManager", () => {
	it("returns the systemd manager on linux", () => {
		expect(createServiceManager("linux")).toBeInstanceOf(LinuxSystemdManager);
	});
	it("returns the launchd manager on darwin", () => {
		expect(createServiceManager("darwin")).toBeInstanceOf(MacosLaunchdManager);
	});
	it("returns the schtasks manager on win32", () => {
		expect(createServiceManager("win32")).toBeInstanceOf(WindowsSchtasksManager);
	});
	it("throws a descriptive error on an unsupported platform", () => {
		expect(() => createServiceManager("freebsd")).toThrow(UnsupportedPlatformError);
		expect(() => createServiceManager("freebsd")).toThrow(/freebsd/);
	});
});
