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

type AnsiStyle = "green" | "red" | "dim" | "bold";

const ANSI_CODES: Record<AnsiStyle, string> = {
	green: "32",
	red: "31",
	dim: "2",
	bold: "1",
};

function paint(text: string, style: AnsiStyle, useColor: boolean): string {
	if (!useColor) {
		return text;
	}
	return `[${ANSI_CODES[style]}m${text}[0m`;
}

function formatHumanValue(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
	}
	return JSON.stringify(value);
}

/**
 * Minimal human renderer for the result object (design doc §4.3). This phase keeps the
 * rendering intentionally plain — a status line plus a key/value summary; the richer
 * tables/spinners are a later phase. Importantly, it shares the exact same result object
 * as the machine envelope so the two channels cannot drift.
 */
export interface HumanRenderInputs {
	ok: boolean;
	command: string;
	data?: Record<string, unknown>;
	errorMessage?: string;
	errorCode?: string;
	useColor: boolean;
}

export function renderHumanResult(inputs: HumanRenderInputs): string {
	const lines: string[] = [];
	if (inputs.ok) {
		lines.push(`${paint("✓", "green", inputs.useColor)} ${paint(inputs.command, "bold", inputs.useColor)}`);
		for (const [key, value] of Object.entries(inputs.data ?? {})) {
			lines.push(`  ${paint(key, "dim", inputs.useColor)}: ${formatHumanValue(value)}`);
		}
	} else {
		lines.push(`${paint("✗", "red", inputs.useColor)} ${inputs.errorMessage ?? "Command failed."}`);
		if (inputs.errorCode) {
			lines.push(paint(`  (code: ${inputs.errorCode})`, "dim", inputs.useColor));
		}
	}
	return lines.join("\n");
}

/** Print the human-rendered result to stdout. */
export function printHumanResult(inputs: HumanRenderInputs): void {
	printLine(renderHumanResult(inputs));
}
