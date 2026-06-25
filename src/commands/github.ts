/**
 * `kanban github …` — GitHub OAuth for **git remote authentication** (push/pull/fetch/clone
 * over github.com HTTPS). Separate from the pi/omp agent-model OAuth.
 *
 *   kanban github status   — show the logged-in account, scope, and expiry
 *   kanban github login    — device-flow login (headless-friendly: prints a code + URL)
 *   kanban github logout    — remove the machine-local credential
 *
 * The credential is machine-local (`~/.kanban/settings/github-auth.json`, 0600) and these
 * commands operate on it **in-process** — so an operator can authenticate over plain SSH on
 * a headless box before (or without) a running runtime, and the runtime picks it up on its
 * next git op. The device code + verification URL are printed to **stderr** so a `--json`
 * stdout document stays clean.
 */
import type { Command } from "commander";
import type { GitHubAuthStatus } from "../github-auth";
import { getGitHubAuthService } from "../github-auth";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";

function renderStatus(status: GitHubAuthStatus): string {
	if (!status.authenticated) {
		return "GitHub: not logged in.\n  Run `kanban github login` to authenticate git operations.";
	}
	const lines = [`GitHub: logged in${status.login ? ` as ${status.login}` : ""}.`];
	if (status.scope) {
		lines.push(`  Scope:   ${status.scope}`);
	}
	lines.push(`  Expires: ${status.expiresAt ? new Date(status.expiresAt).toISOString() : "never (long-lived token)"}`);
	return lines.join("\n");
}

export function registerGithubCommand(program: Command): void {
	const github = program
		.command("github")
		.description("Authenticate git remote operations (github.com HTTPS) with a GitHub OAuth token.");

	github
		.command("status")
		.description("Show the current GitHub git-auth login (account, scope, expiry).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"github.status",
				async () => {
					const status = await getGitHubAuthService().getStatus();
					return { ...status };
				},
				{ globals, renderHuman: (data) => renderStatus(data as unknown as GitHubAuthStatus) },
			);
		});

	github
		.command("login")
		.description("Log in to GitHub via device flow (prints a code + URL; works over SSH/headless).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"github.login",
				async () => {
					const status = await getGitHubAuthService().login({
						onPrompt: (grant) => {
							process.stderr.write(
								`\nTo authenticate git operations with GitHub:\n` +
									`  1. Open ${grant.verificationUri}\n` +
									`  2. Enter the code: ${grant.userCode}\n\n` +
									`Waiting for authorization (the code expires in ${Math.round(grant.expiresInSeconds / 60)} min)…\n`,
							);
						},
					});
					return { ...status };
				},
				{
					globals,
					spinner: { text: "Completing GitHub login…", succeedText: () => "GitHub login complete." },
					renderHuman: (data) => renderStatus(data as unknown as GitHubAuthStatus),
				},
			);
		});

	github
		.command("logout")
		.description("Remove the machine-local GitHub git-auth credential.")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"github.logout",
				async () => {
					await getGitHubAuthService().logout();
					return { authenticated: false };
				},
				{ globals, renderHuman: () => "Logged out of GitHub." },
			);
		});
}
