/**
 * User-facing CLI presentation output — deliberately NOT the diagnostic logger.
 *
 * The startup banner, project URL, and the remote-access passcode are intended
 * program output for the human running `kanban`, so they go to stdout verbatim
 * without a timestamp / level / namespace prefix (which would clutter the
 * banner and, for the passcode, must never be captured in a log file).
 *
 * Diagnostics — anything you'd want to grep later or persist — must use
 * `createLogger` from `./logging` instead.
 */

/** Print a line of user-facing CLI output to stdout. */
export function printLine(message = ""): void {
	process.stdout.write(`${message}\n`);
}
