import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DirectoryPickerCommandCandidate {
	command: string;
	args: string[];
}

type DirectoryPickerCommandResult =
	| { kind: "selected"; path: string }
	| { kind: "cancelled" }
	| { kind: "unavailable" };

/**
 * Normalized child-process result the picker reasons over. Decoupled from
 * `spawnSync`'s return shape so the underlying call can be async (`execFile`)
 * without blocking the runtime's event loop while the native dialog is open.
 */
export interface DirectoryPickerCommandOutput {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException;
}

export type RunCommand = (command: string, args: string[]) => Promise<DirectoryPickerCommandOutput>;

interface PickDirectoryPathFromSystemDialogOptions {
	platform?: NodeJS.Platform;
	cwd?: string;
	runCommand?: RunCommand;
}

const WINDOWS_DIRECTORY_PICKER_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	"$dialog.Description = 'Select a project folder'",
	"$dialog.ShowNewFolderButton = $false",
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

function parseChildProcessErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return null;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return typeof code === "string" ? code : null;
}

async function defaultRunCommand(command: string, args: string[]): Promise<DirectoryPickerCommandOutput> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
		return { status: 0, signal: null, stdout, stderr };
	} catch (rawError) {
		const error = rawError as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
			signal?: NodeJS.Signals | null;
		};
		// A spawn failure (e.g. ENOENT — command not installed) surfaces a STRING
		// errno on `code`; a process that ran but exited non-zero surfaces a NUMBER
		// exit status. Distinguish them so the caller can fall back to the next
		// candidate vs. treat the run as cancelled/errored.
		if (typeof error.code === "string") {
			return { status: null, signal: error.signal ?? null, stdout: "", stderr: "", error };
		}
		return {
			status: typeof error.code === "number" ? error.code : 1,
			signal: error.signal ?? null,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

async function runDirectoryPickerCommand(
	candidate: DirectoryPickerCommandCandidate,
	runCommand: RunCommand,
): Promise<DirectoryPickerCommandResult> {
	const result = await runCommand(candidate.command, candidate.args);

	const errorCode = parseChildProcessErrorCode(result.error);
	if (errorCode === "ENOENT") {
		return { kind: "unavailable" };
	}

	if (result.error) {
		const message = result.error.message || String(result.error);
		throw new Error(`Could not open directory picker via ${candidate.command}: ${message}`);
	}

	if (result.signal) {
		throw new Error(`Directory picker command ${candidate.command} terminated by signal: ${result.signal}`);
	}

	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		if (stderr) {
			const stderrLower = stderr.toLowerCase();
			if (stderrLower.includes("user cancel") || stderrLower.includes("(-128)")) {
				return { kind: "cancelled" };
			}
			throw new Error(`Could not open directory picker via ${candidate.command}: ${stderr}`);
		}
		return { kind: "cancelled" };
	}

	const selectedPath = typeof result.stdout === "string" ? result.stdout.trim() : "";
	if (!selectedPath) {
		return { kind: "cancelled" };
	}

	return { kind: "selected", path: selectedPath };
}

export async function pickDirectoryPathFromSystemDialog(
	options: PickDirectoryPathFromSystemDialogOptions = {},
): Promise<string | null> {
	const platform = options.platform ?? process.platform;
	const cwd = options.cwd ?? process.cwd();
	const runCommand = options.runCommand ?? defaultRunCommand;

	if (platform === "darwin") {
		const result = await runDirectoryPickerCommand(
			{
				command: "osascript",
				args: ["-e", 'POSIX path of (choose folder with prompt "Select a project folder")'],
			},
			runCommand,
		);
		if (result.kind === "selected") {
			return result.path;
		}
		if (result.kind === "cancelled") {
			return null;
		}
		throw new Error('Could not open directory picker. Command "osascript" is not available.');
	}

	if (platform === "linux") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
			{
				command: "kdialog",
				args: ["--getexistingdirectory", cwd, "Select project folder"],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install "zenity" or "kdialog" and try again.');
	}

	if (platform === "win32") {
		const candidates: DirectoryPickerCommandCandidate[] = [
			{
				command: "powershell",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
			{
				command: "pwsh",
				args: ["-NoProfile", "-STA", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
			},
		];

		for (const candidate of candidates) {
			const result = await runDirectoryPickerCommand(candidate, runCommand);
			if (result.kind === "unavailable") {
				continue;
			}
			if (result.kind === "selected") {
				return result.path;
			}
			return null;
		}

		throw new Error('Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.');
	}

	return null;
}
