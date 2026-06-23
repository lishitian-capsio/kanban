/**
 * Default {@link CommandRunner} backed by `child_process.spawnSync`.
 *
 * Service control commands (`systemctl`, `launchctl`, `schtasks`) are short,
 * synchronous, and need their exit code + output, so a blocking spawn (no
 * shell) is the right tool. Managers inject this in production and a recording
 * fake in tests.
 */

import { spawnSync } from "node:child_process";

import type { CommandResult, CommandRunner } from "./service-types";

export const spawnSyncRunner: CommandRunner = (command, args): CommandResult => {
	const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
	if (result.error) {
		return { code: null, stdout: "", stderr: result.error.message };
	}
	return {
		code: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};
