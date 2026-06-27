/**
 * `kanban gitee …` — Gitee Personal Access Token (PAT) for **git remote authentication**
 * (push/pull/fetch/clone over gitee.com HTTPS). Separate from the pi/omp agent-model OAuth.
 *
 *   kanban gitee status   — show the logged-in account / username
 *   kanban gitee login    — store a pasted PAT (flag, stdin pipe, or hidden prompt)
 *   kanban gitee logout    — remove the machine-local credential
 *
 * Unlike `kanban github login`, this is NOT a device flow (Gitee has no device flow): the user
 * generates a PAT on gitee.com and provides it here. The credential is machine-local
 * (`~/.kanban/settings/gitee-auth.json`, 0600) and these commands operate on it **in-process**,
 * so an operator can authenticate over plain SSH on a headless box before (or without) a running
 * runtime, and the runtime picks it up on its next git op.
 *
 * The token is NEVER echoed and NEVER appears in `--json` output (only the secret-free status).
 */
import type { Command } from "commander";
import type { GiteeAuthStatus } from "../gitee-auth";
import { getGiteeAuthService } from "../gitee-auth";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";

// Control-byte codes used by the hidden TTY prompt (kept as named constants so no raw control
// characters need to appear in source).
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;
const CHAR_EOT = 0x04; // Ctrl-D
const CHAR_ETX = 0x03; // Ctrl-C
const CHAR_DEL = 0x7f;
const CHAR_BS = 0x08;
const CHAR_PRINTABLE_MIN = 0x20;

function renderStatus(status: GiteeAuthStatus): string {
	if (!status.authenticated) {
		return "Gitee: not logged in.\n  Run `kanban gitee login` to authenticate git operations.";
	}
	const account = status.login ?? status.username;
	const lines = [`Gitee: logged in${account ? ` as ${account}` : ""}.`];
	if (status.username && status.username !== status.login) {
		lines.push(`  Username: ${status.username}`);
	}
	return lines.join("\n");
}

/**
 * Read a secret line from a non-TTY stdin (piped: `echo "$PAT" | kanban gitee login`). Returns
 * the trimmed first line. On an interactive TTY this returns "" so the caller can fall back to a
 * hidden prompt.
 */
async function readStdinSecret(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("").split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Prompt for a secret on an interactive TTY without echoing the typed characters. */
async function promptHiddenSecret(promptText: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
		return "";
	}
	process.stderr.write(promptText);
	const wasRaw = stdin.isRaw;
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");
	let input = "";
	return await new Promise<string>((resolve) => {
		const finish = (value: string) => {
			stdin.setRawMode?.(wasRaw ?? false);
			stdin.pause();
			stdin.removeListener("data", onData);
			process.stderr.write("\n");
			resolve(value);
		};
		const onData = (data: string) => {
			for (const char of data) {
				const code = char.charCodeAt(0);
				if (code === CHAR_LF || code === CHAR_CR || code === CHAR_EOT) {
					// Enter (LF/CR) or Ctrl-D: submit.
					finish(input.trim());
					return;
				}
				if (code === CHAR_ETX) {
					// Ctrl-C: abort the prompt, restoring the TTY. Resolving empty flows to the
					// "no token provided" path so the command exits via the normal envelope.
					finish("");
					return;
				}
				if (code === CHAR_DEL || code === CHAR_BS) {
					input = input.slice(0, -1);
				} else if (code >= CHAR_PRINTABLE_MIN) {
					// Collect printable characters; ignore other control bytes.
					input += char;
				}
			}
		};
		stdin.on("data", onData);
	});
}

interface GiteeLoginOptionValues {
	token?: string;
	username?: string;
}

export function registerGiteeCommand(program: Command): void {
	const gitee = program
		.command("gitee")
		.description("Authenticate git remote operations (gitee.com HTTPS) with a Gitee personal access token.");

	gitee
		.command("status")
		.description("Show the current Gitee git-auth login (account / username).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"gitee.status",
				async () => {
					const status = await getGiteeAuthService().getStatus();
					return { ...status };
				},
				{ globals, renderHuman: (data) => renderStatus(data as unknown as GiteeAuthStatus) },
			);
		});

	gitee
		.command("login")
		.description("Store a Gitee personal access token (via --token, a stdin pipe, or a hidden prompt).")
		.option("--token <pat>", "The Gitee personal access token. Omit to read from stdin or be prompted.")
		.option("--username <name>", "The Gitee account username paired with the token (recommended).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			const options = this.opts<GiteeLoginOptionValues>();
			// Resolve the token OUTSIDE the spinner: flag → piped stdin → hidden TTY prompt. Never
			// echoed; never logged; never returned in the envelope.
			const token =
				options.token?.trim() ||
				(await readStdinSecret()) ||
				(await promptHiddenSecret("Paste your Gitee personal access token: "));
			const username = options.username?.trim() || undefined;
			await runCliCommand(
				"gitee.login",
				async () => {
					if (!token) {
						throw new Error(
							"No token provided. Pass --token, pipe it on stdin, or run interactively to be prompted.",
						);
					}
					const status = await getGiteeAuthService().login({ token, username });
					return { ...status };
				},
				{
					globals,
					spinner: { text: "Storing Gitee credential…", succeedText: () => "Gitee login complete." },
					renderHuman: (data) => renderStatus(data as unknown as GiteeAuthStatus),
				},
			);
		});

	gitee
		.command("logout")
		.description("Remove the machine-local Gitee git-auth credential.")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"gitee.logout",
				async () => {
					await getGiteeAuthService().logout();
					return { authenticated: false };
				},
				{ globals, renderHuman: () => "Logged out of Gitee." },
			);
		});
}
