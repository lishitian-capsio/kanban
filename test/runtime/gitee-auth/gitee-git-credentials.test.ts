import { describe, expect, it } from "vitest";

import {
	buildGiteeCredentialConfigArgs,
	buildGiteeCredentialEnv,
	GITEE_DEFAULT_USERNAME,
	GITEE_HTTPS_ORIGIN,
	GITEE_TOKEN_ENV_VAR,
	GITEE_USERNAME_ENV_VAR,
} from "../../../src/gitee-auth/gitee-git-credentials";

describe("buildGiteeCredentialConfigArgs", () => {
	const args = buildGiteeCredentialConfigArgs();

	it("scopes the credential helper to https://gitee.com only", () => {
		expect(GITEE_HTTPS_ORIGIN).toBe("https://gitee.com");
		for (const arg of args) {
			if (arg.startsWith("credential.")) {
				expect(arg.startsWith(`credential.${GITEE_HTTPS_ORIGIN}.helper`)).toBe(true);
			}
		}
	});

	it("resets the helper list for gitee.com before installing ours (empty value first)", () => {
		expect(args[0]).toBe("-c");
		expect(args[1]).toBe(`credential.${GITEE_HTTPS_ORIGIN}.helper=`);
		expect(args[2]).toBe("-c");
		expect(args[3].startsWith(`credential.${GITEE_HTTPS_ORIGIN}.helper=!`)).toBe(true);
	});

	it("never embeds a token or username — the helper references env vars instead", () => {
		const joined = args.join(" ");
		expect(joined).toContain(`$${GITEE_TOKEN_ENV_VAR}`);
		expect(joined).toContain(`$${GITEE_USERNAME_ENV_VAR}`);
		// A real token never appears; the args are safe to log / appear in `ps`.
		expect(joined).not.toContain("gitee_pat");
	});
});

describe("buildGiteeCredentialEnv", () => {
	it("carries the token + username in dedicated env vars and disables terminal prompts", () => {
		const env = buildGiteeCredentialEnv("PAT_SECRET", "octocat");
		expect(env[GITEE_TOKEN_ENV_VAR]).toBe("PAT_SECRET");
		expect(env[GITEE_USERNAME_ENV_VAR]).toBe("octocat");
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("falls back to the oauth2 sentinel username when none is supplied", () => {
		expect(buildGiteeCredentialEnv("PAT")[GITEE_USERNAME_ENV_VAR]).toBe(GITEE_DEFAULT_USERNAME);
		expect(buildGiteeCredentialEnv("PAT", "  ")[GITEE_USERNAME_ENV_VAR]).toBe(GITEE_DEFAULT_USERNAME);
	});
});
