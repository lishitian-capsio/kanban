import { afterEach, describe, expect, it } from "vitest";

import { setRuntimeProxyState, setRuntimeProxyStateFromConfig } from "../../src/config/proxy-fetch";
import {
	buildGitSshCommand,
	buildGitSshProxyEnv,
	resetGitSshProxyCacheForTests,
	selectSshProxyHelper,
	SSH_PROXY_HELPERS,
} from "../../src/workspace/git-ssh-proxy";

const DISABLED = { enabled: false, proxyUrl: "", noProxy: "" } as const;
const ALWAYS = (): boolean => true;
const NEVER = (): boolean => false;

describe("selectSshProxyHelper", () => {
	it("prefers socat when available", () => {
		expect(selectSshProxyHelper(false, ALWAYS)?.command).toBe("socat");
	});

	it("falls back to ncat when socat is missing", () => {
		expect(selectSshProxyHelper(false, (bin) => bin !== "socat")?.command).toBe("ncat");
	});

	it("uses corkscrew only when no auth is needed", () => {
		const onlyCorkscrew = (bin: string): boolean => bin === "corkscrew";
		expect(selectSshProxyHelper(false, onlyCorkscrew)?.command).toBe("corkscrew");
		// corkscrew can't carry proxy auth inline (it needs an on-disk auth file),
		// so an authenticated proxy must skip it and there's nothing else available.
		expect(selectSshProxyHelper(true, onlyCorkscrew)).toBeNull();
	});

	it("returns null when no CONNECT helper is on PATH", () => {
		expect(selectSshProxyHelper(false, NEVER)).toBeNull();
	});
});

describe("SSH_PROXY_HELPERS ProxyCommand builders", () => {
	function helper(name: string) {
		const found = SSH_PROXY_HELPERS.find((entry) => entry.command === name);
		if (!found) throw new Error(`missing helper ${name}`);
		return found;
	}

	it("socat embeds the proxy host/port and inline auth, with %h/%p target tokens", () => {
		const cmd = helper("socat").buildProxyCommand({
			host: "proxy.example",
			port: "8080",
			username: "u",
			password: "pw",
		});
		expect(cmd).toContain("PROXY:proxy.example:%h:%p");
		expect(cmd).toContain("proxyport=8080");
		expect(cmd).toContain("proxyauth=u:pw");
	});

	it("ncat passes an http proxy with inline auth and trailing %h %p", () => {
		const cmd = helper("ncat").buildProxyCommand({
			host: "proxy.example",
			port: "8080",
			username: "u",
			password: "pw",
		});
		expect(cmd).toContain("--proxy proxy.example:8080");
		expect(cmd).toContain("--proxy-type http");
		expect(cmd).toContain("--proxy-auth u:pw");
		expect(cmd.endsWith("%h %p")).toBe(true);
	});

	it("corkscrew takes host port %h %p with no auth", () => {
		const cmd = helper("corkscrew").buildProxyCommand({
			host: "proxy.example",
			port: "8080",
			username: "",
			password: "",
		});
		expect(cmd).toBe("corkscrew proxy.example 8080 %h %p");
	});
});

describe("buildGitSshCommand", () => {
	it("wraps the ProxyCommand value in single quotes and defaults to ssh", () => {
		expect(buildGitSshCommand("socat - PROXY:p:%h:%p,proxyport=8080")).toBe(
			"ssh -o ProxyCommand='socat - PROXY:p:%h:%p,proxyport=8080'",
		);
	});

	it("appends to a caller-provided ssh command, preserving it", () => {
		expect(buildGitSshCommand("corkscrew p 8080 %h %p", "ssh -i /keys/id_ed25519")).toBe(
			"ssh -i /keys/id_ed25519 -o ProxyCommand='corkscrew p 8080 %h %p'",
		);
	});

	it("escapes single quotes in the ProxyCommand value (POSIX-safe)", () => {
		expect(buildGitSshCommand("a'b")).toBe(`ssh -o ProxyCommand='a'\\''b'`);
	});
});

describe("buildGitSshProxyEnv", () => {
	afterEach(() => {
		setRuntimeProxyState({ ...DISABLED });
		resetGitSshProxyCacheForTests();
	});

	it("returns {} when the proxy is disabled", () => {
		setRuntimeProxyState({ ...DISABLED });
		expect(buildGitSshProxyEnv(undefined, ALWAYS)).toEqual({});
	});

	it("sets GIT_SSH_COMMAND through the detected helper when enabled", () => {
		setRuntimeProxyStateFromConfig(true, "proxy.example", "8080", "", "", "");
		const env = buildGitSshProxyEnv(undefined, ALWAYS);
		expect(env.GIT_SSH_COMMAND).toContain("ProxyCommand=");
		expect(env.GIT_SSH_COMMAND).toContain("socat");
	});

	it("carries inline auth when the proxy has credentials", () => {
		setRuntimeProxyStateFromConfig(true, "proxy.example", "8080", "user", "pass", "");
		const env = buildGitSshProxyEnv(undefined, ALWAYS);
		expect(env.GIT_SSH_COMMAND).toContain("proxyauth=user:pass");
	});

	it("returns {} when no CONNECT helper is available on PATH", () => {
		setRuntimeProxyStateFromConfig(true, "proxy.example", "8080", "", "", "");
		expect(buildGitSshProxyEnv(undefined, NEVER)).toEqual({});
	});

	it("appends to a caller-provided GIT_SSH_COMMAND", () => {
		setRuntimeProxyStateFromConfig(true, "proxy.example", "8080", "", "", "");
		const env = buildGitSshProxyEnv("ssh -i /keys/id", ALWAYS);
		expect(env.GIT_SSH_COMMAND?.startsWith("ssh -i /keys/id -o ProxyCommand=")).toBe(true);
	});
});
