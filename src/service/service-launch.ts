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

/**
 * Bun runtime flags that MUST precede the script path.
 *
 * `--no-env-file` disables Bun's default auto-loading of a `.env` in the
 * process cwd. A service runs with `WorkingDirectory` = the user's repo and
 * under a minimal (non-interactive) environment, so a stray `.env` in that
 * repo would otherwise be injected into any KANBAN_-prefixed, proxy, or
 * credential-path var the user's shell didn't already set. Kanban never reads
 * its own config from a `.env`, so disabling this breaks nothing (see AGENTS.md).
 */
export const BUN_RUNTIME_FLAGS: readonly string[] = ["--no-env-file"];

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

/** Build the full launch command: `[bun, ...bunFlags, script, ...args]`. */
export function buildServiceCommand(config: ServiceConfig): string[] {
	return [config.bunPath, ...BUN_RUNTIME_FLAGS, config.scriptPath, ...buildServiceLaunchArgs(config)];
}
