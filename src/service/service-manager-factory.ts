/**
 * Selects the right {@link ServiceManager} for the host platform.
 *
 * The platform string mirrors `process.platform` so callers can pass it
 * directly; tests pass literal values to exercise each branch without mocking
 * the global.
 */

import { LinuxSystemdManager } from "./platform/linux-systemd-manager";
import { MacosLaunchdManager } from "./platform/macos-launchd-manager";
import { WindowsSchtasksManager } from "./platform/windows-schtasks-manager";
import type { ServiceManager } from "./service-types";

export class UnsupportedPlatformError extends Error {
	constructor(platform: string) {
		super(
			`Kanban services are not supported on platform "${platform}". ` +
				"Supported platforms: linux (systemd), darwin (launchd), win32 (Task Scheduler).",
		);
		this.name = "UnsupportedPlatformError";
	}
}

/** Build the native service manager for the given `process.platform` value. */
export function createServiceManager(platform: NodeJS.Platform | string = process.platform): ServiceManager {
	switch (platform) {
		case "linux":
			return new LinuxSystemdManager();
		case "darwin":
			return new MacosLaunchdManager();
		case "win32":
			return new WindowsSchtasksManager();
		default:
			throw new UnsupportedPlatformError(platform);
	}
}
