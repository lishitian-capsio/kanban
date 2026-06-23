/**
 * Pure construction of the runtime launch command a service runs.
 *
 * The two non-negotiable flags:
 *  - `--skip-shutdown-cleanup`: a service is restarted by the OS on crash /
 *    logout, and without this the runtime would delete `.kanban/worktrees/*`
 *    on every stop (see AGENTS.md), destroying in-flight task worktrees.
 *  - `--no-open`: a background service must never try to open a browser tab.
 */

import type { ServiceConfig } from "./service-types";

/** Build the runtime CLI args (everything after the script path). */
export function buildServiceLaunchArgs(config: ServiceConfig): string[] {
	const args: string[] = ["--skip-shutdown-cleanup", "--no-open"];
	if (config.host !== undefined && config.host.length > 0) {
		args.push("--host", config.host);
	}
	if (config.port !== undefined) {
		args.push("--port", String(config.port));
	}
	if (config.passcode === false) {
		args.push("--no-passcode");
	}
	if (config.extraArgs && config.extraArgs.length > 0) {
		args.push(...config.extraArgs);
	}
	return args;
}

/** Build the full launch command: `[bun, script, ...args]`. */
export function buildServiceCommand(config: ServiceConfig): string[] {
	return [config.bunPath, config.scriptPath, ...buildServiceLaunchArgs(config)];
}
