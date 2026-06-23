/**
 * Resolves the {@link ServiceConfig} for the running Kanban install.
 *
 * Path resolution is intentionally split from the pure option→config mapping
 * so the latter is unit-testable: {@link resolveServicePaths} touches the
 * process (the bun binary, the CLI entry, cwd, the logs dir) while
 * {@link buildServiceConfig} is a pure function of its inputs.
 */

import { resolve } from "node:path";

import { getLogsDir } from "../logging/logger";
import { DEFAULT_SERVICE_NAME, type ServiceConfig } from "./service-types";

/** CLI option shape shared by all `kanban service` subcommands. */
export interface ServiceCliOptions {
	name?: string;
	host?: string;
	port?: number;
	noPasscode?: boolean;
	/** Extra runtime args appended verbatim to the launch command. */
	extraArgs?: string[];
}

/** Absolute paths the service launch command is built from. */
export interface ResolvedServicePaths {
	bunPath: string;
	scriptPath: string;
	workingDir: string;
	logDir: string;
}

/**
 * Resolve the absolute paths the service needs.
 *
 * `process.execPath` is the bun binary that is currently running the CLI, and
 * `process.argv[1]` is the CLI entry (`dist/cli.js` in a build, `src/cli.ts`
 * in dev). Both are resolved to absolute so the service never depends on the
 * installer's cwd.
 */
export function resolveServicePaths(cwd: string = process.cwd()): ResolvedServicePaths {
	const scriptArg = process.argv[1];
	if (!scriptArg) {
		throw new Error("Unable to determine the Kanban CLI entry path (process.argv[1] is empty).");
	}
	return {
		bunPath: process.execPath,
		scriptPath: resolve(scriptArg),
		workingDir: resolve(cwd),
		logDir: getLogsDir(),
	};
}

/** Pure mapping from parsed CLI options + resolved paths to a {@link ServiceConfig}. */
export function buildServiceConfig(options: ServiceCliOptions, paths: ResolvedServicePaths): ServiceConfig {
	return {
		name: options.name ?? DEFAULT_SERVICE_NAME,
		bunPath: paths.bunPath,
		scriptPath: paths.scriptPath,
		workingDir: paths.workingDir,
		logDir: paths.logDir,
		host: options.host,
		port: options.port,
		passcode: options.noPasscode !== true,
		extraArgs: options.extraArgs && options.extraArgs.length > 0 ? options.extraArgs : undefined,
	};
}
