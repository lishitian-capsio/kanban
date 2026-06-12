import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	applyProxyToProcessEnv,
	buildProxyEnvVars,
	mergeNoProxyEntries,
	shouldBypassProxy,
} from "../../src/config/proxy-env";

describe("mergeNoProxyEntries", () => {
	it("appends new hosts after existing entries", () => {
		expect(mergeNoProxyEntries("localhost,127.0.0.1", ["192.168.50.203"])).toBe("localhost,127.0.0.1,192.168.50.203");
	});

	it("preserves existing entries and their order", () => {
		expect(mergeNoProxyEntries("example.com,localhost", ["192.168.50.203"])).toBe(
			"example.com,localhost,192.168.50.203",
		);
	});

	it("is idempotent when a host is already present", () => {
		const once = mergeNoProxyEntries("localhost", ["192.168.50.203"]);
		expect(mergeNoProxyEntries(once, ["192.168.50.203"])).toBe(once);
	});

	it("deduplicates case-insensitively, keeping the first occurrence", () => {
		expect(mergeNoProxyEntries("LocalHost", ["localhost", "127.0.0.1"])).toBe("LocalHost,127.0.0.1");
	});

	it("trims whitespace and skips empty entries", () => {
		expect(mergeNoProxyEntries(" localhost , , 127.0.0.1 ", [" 192.168.50.203 ", ""])).toBe(
			"localhost,127.0.0.1,192.168.50.203",
		);
	});

	it("handles missing existing value", () => {
		expect(mergeNoProxyEntries(undefined, ["localhost", "192.168.50.203"])).toBe("localhost,192.168.50.203");
		expect(mergeNoProxyEntries(null, ["localhost"])).toBe("localhost");
		expect(mergeNoProxyEntries("", ["localhost"])).toBe("localhost");
	});
});

describe("shouldBypassProxy", () => {
	it("always bypasses loopback hosts regardless of the list", () => {
		expect(shouldBypassProxy("localhost", "")).toBe(true);
		expect(shouldBypassProxy("127.0.0.1", "")).toBe(true);
		expect(shouldBypassProxy("::1", "")).toBe(true);
		expect(shouldBypassProxy("[::1]", "")).toBe(true);
	});

	it("does not bypass a non-loopback host when the list is empty", () => {
		expect(shouldBypassProxy("api.openai.com", "")).toBe(false);
	});

	it("bypasses an exact host match (case-insensitive)", () => {
		expect(shouldBypassProxy("example.com", "example.com,foo.com")).toBe(true);
		expect(shouldBypassProxy("Example.COM", "example.com")).toBe(true);
	});

	it("bypasses subdomains of a bare domain entry", () => {
		expect(shouldBypassProxy("api.example.com", "example.com")).toBe(true);
	});

	it("bypasses subdomains of a leading-dot entry", () => {
		expect(shouldBypassProxy("api.example.com", ".example.com")).toBe(true);
	});

	it("does not match on a non-boundary suffix", () => {
		expect(shouldBypassProxy("notexample.com", "example.com")).toBe(false);
	});

	it("bypasses everything when the list contains a wildcard", () => {
		expect(shouldBypassProxy("anything.example.org", "*")).toBe(true);
	});

	it("matches against the bound runtime host", () => {
		expect(shouldBypassProxy("192.168.50.203", "localhost,127.0.0.1,192.168.50.203")).toBe(true);
	});

	describe("re: regex entries", () => {
		it("bypasses a host matched by a re: regex entry", () => {
			expect(shouldBypassProxy("token-plan.cn-beijing.maas.aliyuncs.com", "re:\\.aliyuncs\\.com$")).toBe(true);
		});

		it("does not bypass a host the re: regex entry fails to match", () => {
			expect(shouldBypassProxy("api.openai.com", "re:\\.aliyuncs\\.com$")).toBe(false);
		});

		it("matches the regex case-insensitively against the host", () => {
			expect(shouldBypassProxy("token-plan.CN-Beijing.MAAS.aliyuncs.com", "re:\\.ALIYUNCS\\.COM$")).toBe(true);
		});

		it("ignores an invalid regex entry without throwing", () => {
			expect(() => shouldBypassProxy("api.openai.com", "re:[unterminated")).not.toThrow();
			expect(shouldBypassProxy("api.openai.com", "re:[unterminated")).toBe(false);
		});

		it("keeps evaluating later entries when an earlier regex is invalid", () => {
			expect(shouldBypassProxy("api.openai.com", "re:[bad,api.openai.com")).toBe(true);
		});

		it("ignores an empty re: pattern instead of matching everything", () => {
			expect(shouldBypassProxy("api.openai.com", "re:")).toBe(false);
			expect(shouldBypassProxy("api.openai.com", "re:   ")).toBe(false);
		});

		it("mixes regex and suffix entries in the same list", () => {
			const list = "example.com,re:^token-plan\\..*\\.aliyuncs\\.com$";
			expect(shouldBypassProxy("api.example.com", list)).toBe(true);
			expect(shouldBypassProxy("token-plan.cn-beijing.maas.aliyuncs.com", list)).toBe(true);
			expect(shouldBypassProxy("api.openai.com", list)).toBe(false);
		});

		it("treats the re: prefix case-insensitively", () => {
			expect(shouldBypassProxy("token-plan.cn-beijing.maas.aliyuncs.com", "RE:\\.aliyuncs\\.com$")).toBe(true);
		});

		it("does not treat a regex pattern as a suffix rule when it fails to compile", () => {
			// A bare suffix that happens to start with the regex prefix is still parsed as regex.
			expect(shouldBypassProxy("re.example.com", "re:example")).toBe(true);
		});
	});
});

describe("buildProxyEnvVars with extra no-proxy hosts", () => {
	it("merges extra no-proxy hosts into NO_PROXY when proxy is enabled", () => {
		const vars = buildProxyEnvVars(true, "proxy.local", "7897", "", "", "localhost,127.0.0.1", ["192.168.50.203"]);
		expect(vars.NO_PROXY).toBe("localhost,127.0.0.1,192.168.50.203");
		expect(vars.no_proxy).toBe("localhost,127.0.0.1,192.168.50.203");
	});

	it("sets NO_PROXY from extra hosts even when the configured no-proxy is empty", () => {
		const vars = buildProxyEnvVars(true, "proxy.local", "7897", "", "", "", ["192.168.50.203"]);
		expect(vars.NO_PROXY).toBe("192.168.50.203");
	});

	it("does not add proxy vars when proxy is disabled", () => {
		expect(buildProxyEnvVars(false, "proxy.local", "7897", "", "", "", ["192.168.50.203"])).toEqual({});
	});
});

describe("applyProxyToProcessEnv with extra no-proxy hosts", () => {
	const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of PROXY_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_KEYS) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	});

	it("keeps the runtime self-hosts in NO_PROXY when proxy is enabled", () => {
		applyProxyToProcessEnv(true, "proxy.local", "7897", "", "", "corp.internal", ["192.168.50.203"]);
		expect(process.env.NO_PROXY).toBe("corp.internal,192.168.50.203");
		expect(process.env.HTTP_PROXY).toBe("http://proxy.local:7897");
	});
});
