/**
 * Pure builders for Windows `schtasks.exe` argument arrays.
 *
 * We use Task Scheduler (not a true Windows Service) because it needs no extra
 * dependency and an `ONLOGON` trigger requires no admin rights. The README
 * documents NSSM as the upgrade path for a real always-on Windows Service.
 *
 * `/TR` is a single string the scheduler stores verbatim, so the program path
 * is double-quoted inside it. The arrays are passed to `spawnSync` WITHOUT a
 * shell, so no further shell-escaping is applied here.
 */

import { BUN_RUNTIME_FLAGS, buildServiceLaunchArgs } from "../service-launch";
import type { ServiceConfig } from "../service-types";

/** Build the `/TR` task-run command string (`"bun" --no-env-file "cli.js" <args>`). */
export function buildSchtasksTaskRunString(config: ServiceConfig): string {
	const launchArgs = buildServiceLaunchArgs(config);
	return [`"${config.bunPath}"`, ...BUN_RUNTIME_FLAGS, `"${config.scriptPath}"`, ...launchArgs].join(" ");
}

/** `schtasks /Create` args: an at-logon task, force-overwriting any existing. */
export function buildSchtasksCreateArgs(config: ServiceConfig): string[] {
	return [
		"/Create",
		"/TN",
		config.name,
		"/TR",
		buildSchtasksTaskRunString(config),
		"/SC",
		"ONLOGON",
		"/RL",
		"LIMITED",
		"/F",
	];
}

/** `schtasks /Delete` args. */
export function buildSchtasksDeleteArgs(name: string): string[] {
	return ["/Delete", "/TN", name, "/F"];
}

/** `schtasks /Run` args. */
export function buildSchtasksRunArgs(name: string): string[] {
	return ["/Run", "/TN", name];
}

/** `schtasks /End` args. */
export function buildSchtasksEndArgs(name: string): string[] {
	return ["/End", "/TN", name];
}

/** `schtasks /Query` args (verbose list format, machine-parseable). */
export function buildSchtasksQueryArgs(name: string): string[] {
	return ["/Query", "/TN", name, "/FO", "LIST", "/V"];
}
