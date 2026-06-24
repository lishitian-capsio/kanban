import type { Command } from "commander";

import { printLine } from "../cli-output";
import { getPasscodeFilePath, readPersistedPasscode } from "../security/passcode-store";

/**
 * `kanban passcode` — print the current persisted remote-access passcode.
 *
 * In remote mode the passcode is otherwise only visible in the startup banner,
 * so an operator who lost it (or restarted the service) had no way to retrieve
 * it short of digging through logs. This reads the persisted value and prints it
 * via {@link printLine} — clean stdout, never the log file (the passcode is a secret).
 */
export function registerPasscodeCommand(program: Command): void {
	program
		.command("passcode")
		.description("Print the current remote-access passcode (sensitive — written to stdout only).")
		.action(async () => {
			const value = await readPersistedPasscode(getPasscodeFilePath());
			if (!value) {
				printLine(
					"No remote-access passcode is set yet.\n" +
						"It is created the first time Kanban binds to a non-localhost host — e.g.\n" +
						"  kanban --host <ip>            (or `kanban service install --host <ip>`)\n" +
						"To pin a fixed one: `kanban --host <ip> --passcode <value>` or set KANBAN_PASSCODE.",
				);
				return;
			}
			printLine(`🔐 Remote access passcode: ${value}`);
		});
}
