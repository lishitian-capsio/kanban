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

import ora from "ora";

/** Print a line of user-facing CLI output to stdout. */
export function printLine(message = ""): void {
	process.stdout.write(`${message}\n`);
}

/**
 * Emit a one-line deprecation notice to **stderr** (design doc §8). Kept off stdout so it
 * never pollutes a `--json` document or a piped human result. Silenced when
 * `KANBAN_SUPPRESS_DEPRECATION` is set (for known-migrated scripts).
 */
export function emitDeprecationWarning(message: string): void {
	if (process.env.KANBAN_SUPPRESS_DEPRECATION) {
		return;
	}
	process.stderr.write(`⚠️  ${message}\n`);
}

/**
 * Whether ANSI color should be used for human output. Disabled when stdout is not a
 * TTY, when `NO_COLOR` is set (https://no-color.org), or when explicitly opted out.
 * (The `--no-color` global flag is wired in a later phase; `noColorOverride` is the seam.)
 */
export function shouldUseColor(noColorOverride = false): boolean {
	if (noColorOverride) {
		return false;
	}
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
		return false;
	}
	return Boolean(process.stdout?.isTTY);
}

export type AnsiStyle = "green" | "red" | "dim" | "bold" | "cyan" | "yellow";

const ANSI_CODES: Record<AnsiStyle, string> = {
	green: "32",
	red: "31",
	dim: "2",
	bold: "1",
	cyan: "36",
	yellow: "33",
};

/**
 * Wrap `text` in the ANSI escape for `style`, or return it unchanged when `useColor` is
 * false (so the same render code path serves both the colored TTY view and the plain
 * `--no-color`/non-TTY view — see {@link shouldUseColor}). Exported so the richer human
 * renderers in `cli-human-render.ts` share this single source of color truth.
 */
export function paint(text: string, style: AnsiStyle, useColor: boolean): string {
	if (!useColor) {
		return text;
	}
	return `[${ANSI_CODES[style]}m${text}[0m`;
}

/**
 * A started progress spinner with a terminal success/failure transition (design doc §4.3,
 * "long-running"). Mirrors the `createShutdownIndicator` pattern in `cli.ts`: a real `ora`
 * spinner on a TTY, a plain one-line fallback when the stream is not a TTY.
 */
export interface CliSpinner {
	succeed(text?: string): void;
	fail(text?: string): void;
}

/**
 * Start a spinner on `stream` (stderr by default, so it never pollutes the stdout result
 * document) and return its terminal-transition handle. Callers gate on output mode/`--quiet`
 * before calling — this helper only handles the TTY-vs-plain rendering split.
 */
export function startCliSpinner(text: string, stream: NodeJS.WriteStream = process.stderr): CliSpinner {
	if (!stream.isTTY) {
		stream.write(`${text}\n`);
		return {
			succeed(done) {
				if (done) {
					stream.write(`${done}\n`);
				}
			},
			fail(failure) {
				if (failure) {
					stream.write(`${failure}\n`);
				}
			},
		};
	}
	const spinner = ora({ text, stream }).start();
	return {
		succeed(done) {
			spinner.succeed(done ?? text);
		},
		fail(failure) {
			spinner.fail(failure ?? text);
		},
	};
}
