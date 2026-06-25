import { describe, expect, it } from "vitest";

import {
	buildGitHubCredentialConfigArgs,
	buildGitHubCredentialEnv,
	GITHUB_HTTPS_ORIGIN,
	GITHUB_TOKEN_ENV_VAR,
} from "../../../src/github-auth/github-git-credentials";

describe("buildGitHubCredentialConfigArgs", () => {
	const args = buildGitHubCredentialConfigArgs();

	it("scopes the credential helper to https://github.com only", () => {
		expect(GITHUB_HTTPS_ORIGIN).toBe("https://github.com");
		for (const arg of args) {
			if (arg.startsWith("credential.")) {
				expect(arg.startsWith(`credential.${GITHUB_HTTPS_ORIGIN}.helper`)).toBe(true);
			}
		}
	});

	it("resets the helper list for github.com before installing ours (empty value first)", () => {
		// Shape: -c credential.https://github.com.helper=  -c credential.https://github.com.helper=!...
		expect(args[0]).toBe("-c");
		expect(args[1]).toBe(`credential.${GITHUB_HTTPS_ORIGIN}.helper=`);
		expect(args[2]).toBe("-c");
		expect(args[3].startsWith(`credential.${GITHUB_HTTPS_ORIGIN}.helper=!`)).toBe(true);
	});

	it("never embeds a token — the helper references an env var instead", () => {
		const joined = args.join(" ");
		expect(joined).toContain(`$${GITHUB_TOKEN_ENV_VAR}`);
		// A real token never appears; the args are safe to log / appear in `ps`.
		expect(joined).not.toContain("ghp_");
		expect(joined).not.toContain("gho_");
	});

	it("uses x-access-token as the basic-auth username", () => {
		expect(args.join(" ")).toContain("username=x-access-token");
	});
});

describe("buildGitHubCredentialEnv", () => {
	it("carries the token in the dedicated env var and disables terminal prompts", () => {
		const env = buildGitHubCredentialEnv("ghs_SECRET");
		expect(env[GITHUB_TOKEN_ENV_VAR]).toBe("ghs_SECRET");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});
});
