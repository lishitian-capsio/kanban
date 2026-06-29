import { describe, expect, it } from "vitest";

import {
	type DirectoryPickerCommandOutput,
	pickDirectoryPathFromSystemDialog,
	type RunCommand,
} from "../../src/server/directory-picker";

interface RecordedCommand {
	command: string;
	args: string[];
}

function createSpawnResult(overrides: Partial<DirectoryPickerCommandOutput> = {}): DirectoryPickerCommandOutput {
	return {
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	};
}

function createRunCommand(
	responses: Record<string, DirectoryPickerCommandOutput>,
	commands: RecordedCommand[],
): RunCommand {
	return async (command: string, args: string[]) => {
		commands.push({ command, args });
		const response = responses[command];
		if (!response) {
			throw new Error(`Unexpected command: ${command}`);
		}
		return response;
	};
}

describe("pickDirectoryPathFromSystemDialog", () => {
	// The native dialog blocks for as long as the user stares at it. It must run
	// across an async boundary so the runtime keeps serving other clients (and its
	// own event loop) while the picker is open, instead of hard-freezing.
	it("returns control to the event loop while the dialog is open", async () => {
		const slowRunCommand: RunCommand = () =>
			new Promise((resolve) => setTimeout(() => resolve(createSpawnResult({ stdout: "/tmp/picked\n" })), 60));
		const pending = pickDirectoryPathFromSystemDialog({
			platform: "linux",
			runCommand: slowRunCommand,
		});
		const winner = await Promise.race([
			pending.then(() => "picker"),
			new Promise<string>((resolve) => setTimeout(() => resolve("timer"), 10)),
		]);
		expect(winner).toBe("timer");
		expect(await pending).toBe("/tmp/picked");
	});

	it("falls back to kdialog when zenity is unavailable on linux", async () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = await pickDirectoryPathFromSystemDialog({
			platform: "linux",
			cwd: "/tmp",
			runCommand: createRunCommand(
				{
					zenity: createSpawnResult({
						status: null,
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
					kdialog: createSpawnResult({
						stdout: "/tmp/my-repo\n",
					}),
				},
				commands,
			),
		});

		expect(selectedPath).toBe("/tmp/my-repo");
		expect(commands).toEqual([
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
			{
				command: "kdialog",
				args: ["--getexistingdirectory", "/tmp", "Select project folder"],
			},
		]);
	});

	it("returns null when the picker is cancelled", async () => {
		const commands: RecordedCommand[] = [];
		const selectedPath = await pickDirectoryPathFromSystemDialog({
			platform: "linux",
			runCommand: createRunCommand(
				{
					zenity: createSpawnResult({
						status: 1,
					}),
				},
				commands,
			),
		});

		expect(selectedPath).toBeNull();
		expect(commands).toEqual([
			{
				command: "zenity",
				args: ["--file-selection", "--directory", "--title=Select project folder"],
			},
		]);
	});

	it("throws a clear error when no linux picker commands are installed", async () => {
		const commands: RecordedCommand[] = [];
		await expect(
			pickDirectoryPathFromSystemDialog({
				platform: "linux",
				runCommand: createRunCommand(
					{
						zenity: createSpawnResult({
							status: null,
							error: {
								code: "ENOENT",
								message: "command not found",
							} as NodeJS.ErrnoException,
						}),
						kdialog: createSpawnResult({
							status: null,
							error: {
								code: "ENOENT",
								message: "command not found",
							} as NodeJS.ErrnoException,
						}),
					},
					commands,
				),
			}),
		).rejects.toThrow('Could not open directory picker. Install "zenity" or "kdialog" and try again.');
	});

	it("throws command stderr when picker fails for a real error", async () => {
		await expect(
			pickDirectoryPathFromSystemDialog({
				platform: "linux",
				runCommand: createRunCommand(
					{
						zenity: createSpawnResult({
							status: 1,
							stderr: "Gtk warning",
						}),
					},
					[],
				),
			}),
		).rejects.toThrow("Could not open directory picker via zenity: Gtk warning");
	});
});

it("uses powershell on windows when available", async () => {
	const commands: RecordedCommand[] = [];
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					stdout: "C:\\Users\\dev\\repo\n",
				}),
			},
			commands,
		),
	});

	expect(selectedPath).toBe("C:\\Users\\dev\\repo");
	expect(commands).toHaveLength(1);
	expect(commands[0]?.command).toBe("powershell");
	expect(commands[0]?.args.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-Command"]);
});

it("falls back to pwsh when powershell is unavailable on windows", async () => {
	const commands: RecordedCommand[] = [];
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					status: null,
					error: {
						code: "ENOENT",
						message: "command not found",
					} as NodeJS.ErrnoException,
				}),
				pwsh: createSpawnResult({
					stdout: "C:\\Users\\dev\\repo\n",
				}),
			},
			commands,
		),
	});

	expect(selectedPath).toBe("C:\\Users\\dev\\repo");
	expect(commands.map((entry) => entry.command)).toEqual(["powershell", "pwsh"]);
});

it("returns null when windows picker is cancelled", async () => {
	const selectedPath = await pickDirectoryPathFromSystemDialog({
		platform: "win32",
		runCommand: createRunCommand(
			{
				powershell: createSpawnResult({
					status: 1,
				}),
			},
			[],
		),
	});

	expect(selectedPath).toBeNull();
});

it("throws a clear error when no windows picker commands are installed", async () => {
	await expect(
		pickDirectoryPathFromSystemDialog({
			platform: "win32",
			runCommand: createRunCommand(
				{
					powershell: createSpawnResult({
						status: null,
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
					pwsh: createSpawnResult({
						status: null,
						error: {
							code: "ENOENT",
							message: "command not found",
						} as NodeJS.ErrnoException,
					}),
				},
				[],
			),
		}),
	).rejects.toThrow('Could not open directory picker. Install PowerShell ("powershell" or "pwsh") and try again.');
});
