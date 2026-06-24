import { afterEach, describe, expect, it } from "vitest";

import {
	buildKanbanRuntimeUrl,
	buildKanbanRuntimeWsUrl,
	clearKanbanRuntimeTls,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeAllowedHosts,
	getKanbanRuntimeHost,
	getKanbanRuntimeNoProxyHosts,
	getKanbanRuntimePort,
	getLocalNetworkHosts,
	getRuntimeFetch,
	isKanbanRuntimeHttps,
	isLoopbackHost,
	isWildcardBindHost,
	parseRuntimePort,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
	setKanbanRuntimeTls,
} from "../../src/core/runtime-endpoint";

const originalRuntimePort = getKanbanRuntimePort();
const originalRuntimeHost = getKanbanRuntimeHost();
const originalEnvPort = process.env.KANBAN_RUNTIME_PORT;
const originalEnvHost = process.env.KANBAN_RUNTIME_HOST;
const originalEnvHttps = process.env.KANBAN_RUNTIME_HTTPS;
const originalEnvTlsCa = process.env.KANBAN_RUNTIME_TLS_CA;
const originalEnvNoProxy = process.env.NO_PROXY;
const originalEnvNoProxyLower = process.env.no_proxy;
const originalEnvAllowedHosts = process.env.KANBAN_RUNTIME_ALLOWED_HOSTS;

afterEach(() => {
	setKanbanRuntimePort(originalRuntimePort);
	setKanbanRuntimeHost(originalRuntimeHost);
	clearKanbanRuntimeTls();
	if (originalEnvNoProxy === undefined) {
		delete process.env.NO_PROXY;
	} else {
		process.env.NO_PROXY = originalEnvNoProxy;
	}
	if (originalEnvNoProxyLower === undefined) {
		delete process.env.no_proxy;
	} else {
		process.env.no_proxy = originalEnvNoProxyLower;
	}
	if (originalEnvPort === undefined) {
		delete process.env.KANBAN_RUNTIME_PORT;
	} else {
		process.env.KANBAN_RUNTIME_PORT = originalEnvPort;
	}
	if (originalEnvHost === undefined) {
		delete process.env.KANBAN_RUNTIME_HOST;
	} else {
		process.env.KANBAN_RUNTIME_HOST = originalEnvHost;
	}
	if (originalEnvHttps === undefined) {
		delete process.env.KANBAN_RUNTIME_HTTPS;
	} else {
		process.env.KANBAN_RUNTIME_HTTPS = originalEnvHttps;
	}
	if (originalEnvTlsCa === undefined) {
		delete process.env.KANBAN_RUNTIME_TLS_CA;
	} else {
		process.env.KANBAN_RUNTIME_TLS_CA = originalEnvTlsCa;
	}
	if (originalEnvAllowedHosts === undefined) {
		delete process.env.KANBAN_RUNTIME_ALLOWED_HOSTS;
	} else {
		process.env.KANBAN_RUNTIME_ALLOWED_HOSTS = originalEnvAllowedHosts;
	}
});

describe("runtime-endpoint", () => {
	it("parses default port when env value is missing", () => {
		expect(parseRuntimePort(undefined)).toBe(DEFAULT_KANBAN_RUNTIME_PORT);
	});

	it("throws for invalid ports", () => {
		expect(() => parseRuntimePort("0")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("70000")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("abc")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
	});

	it("updates runtime url builders when port changes", () => {
		setKanbanRuntimePort(4567);
		expect(getKanbanRuntimePort()).toBe(4567);
		expect(process.env.KANBAN_RUNTIME_PORT).toBe("4567");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://127.0.0.1:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/terminal/ws")).toBe("ws://127.0.0.1:4567/api/terminal/ws");
	});

	it("updates runtime url builders when host changes", () => {
		setKanbanRuntimeHost("100.64.0.1");
		setKanbanRuntimePort(4567);
		expect(getKanbanRuntimeHost()).toBe("100.64.0.1");
		expect(process.env.KANBAN_RUNTIME_HOST).toBe("100.64.0.1");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://100.64.0.1:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/terminal/ws")).toBe("ws://100.64.0.1:4567/api/terminal/ws");
	});

	it("defaults host to 127.0.0.1", () => {
		expect(getKanbanRuntimeHost()).toBe("127.0.0.1");
	});

	it("adds the bound host to NO_PROXY so self-communication bypasses the proxy", () => {
		process.env.NO_PROXY = "localhost,127.0.0.1";
		process.env.no_proxy = "localhost,127.0.0.1";
		setKanbanRuntimeHost("192.168.50.203");
		expect(process.env.NO_PROXY?.split(",")).toContain("192.168.50.203");
		expect(process.env.no_proxy?.split(",")).toContain("192.168.50.203");
	});

	it("does not duplicate the bound host in NO_PROXY when re-bound", () => {
		setKanbanRuntimeHost("192.168.50.203");
		setKanbanRuntimeHost("192.168.50.203");
		const occurrences = (process.env.NO_PROXY ?? "").split(",").filter((h) => h === "192.168.50.203");
		expect(occurrences).toHaveLength(1);
	});

	it("preserves a user's pre-existing NO_PROXY entries when binding a host", () => {
		process.env.NO_PROXY = "corp.internal,example.com";
		setKanbanRuntimeHost("192.168.50.203");
		const entries = (process.env.NO_PROXY ?? "").split(",");
		expect(entries).toContain("corp.internal");
		expect(entries).toContain("example.com");
		expect(entries).toContain("192.168.50.203");
	});

	it("exposes the runtime self-hosts (loopback + bound host) for proxy env wiring", () => {
		setKanbanRuntimeHost("192.168.50.203");
		expect(getKanbanRuntimeNoProxyHosts()).toEqual(["localhost", "127.0.0.1", "::1", "192.168.50.203"]);
	});

	it("switches runtime url builders to https and wss when tls is enabled", () => {
		setKanbanRuntimeHost("localhost");
		setKanbanRuntimePort(4567);
		setKanbanRuntimeTls({
			cert: "test-cert",
			key: "test-key",
			ca: "test-cert",
		});
		expect(isKanbanRuntimeHttps()).toBe(true);
		expect(process.env.KANBAN_RUNTIME_HTTPS).toBe("1");
		expect(process.env.KANBAN_RUNTIME_TLS_CA).toBe("test-cert");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("https://localhost:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/terminal/ws")).toBe("wss://localhost:4567/api/terminal/ws");
	});

	it("creates a pinned runtime fetch only when a tls ca is configured", async () => {
		expect(await getRuntimeFetch()).toBe(globalThis.fetch);
		setKanbanRuntimeTls({
			cert: "test-cert",
			key: "test-key",
			ca: "test-cert",
		});
		expect(await getRuntimeFetch()).not.toBe(globalThis.fetch);
	});
});

describe("isLoopbackHost", () => {
	it("recognises the loopback aliases regardless of casing", () => {
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("LOCALHOST")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
	});

	it("does not treat a wildcard bind or a LAN IP as loopback", () => {
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("::")).toBe(false);
		expect(isLoopbackHost("192.168.50.203")).toBe(false);
	});
});

describe("isWildcardBindHost", () => {
	it("recognises the IPv4/IPv6 wildcard bind addresses and the empty host", () => {
		expect(isWildcardBindHost("0.0.0.0")).toBe(true);
		expect(isWildcardBindHost("::")).toBe(true);
		expect(isWildcardBindHost("")).toBe(true);
		expect(isWildcardBindHost("  ")).toBe(true);
	});

	it("does not treat loopback or a concrete LAN IP as a wildcard bind", () => {
		expect(isWildcardBindHost("127.0.0.1")).toBe(false);
		expect(isWildcardBindHost("localhost")).toBe(false);
		expect(isWildcardBindHost("192.168.50.203")).toBe(false);
	});
});

describe("getKanbanRuntimeAllowedHosts", () => {
	it("returns an empty list when the env var is unset or blank", () => {
		delete process.env.KANBAN_RUNTIME_ALLOWED_HOSTS;
		expect(getKanbanRuntimeAllowedHosts()).toEqual([]);
		process.env.KANBAN_RUNTIME_ALLOWED_HOSTS = "  ,  ";
		expect(getKanbanRuntimeAllowedHosts()).toEqual([]);
	});

	it("parses a comma-separated list, trimming and lowercasing entries", () => {
		process.env.KANBAN_RUNTIME_ALLOWED_HOSTS = " Kanban.Local , 192.168.50.203 ,, board.example.com ";
		expect(getKanbanRuntimeAllowedHosts()).toEqual(["kanban.local", "192.168.50.203", "board.example.com"]);
	});
});

describe("getLocalNetworkHosts", () => {
	it("returns a de-duplicated list of non-loopback, non-wildcard host strings", () => {
		const hosts = getLocalNetworkHosts();
		expect(Array.isArray(hosts)).toBe(true);
		expect(new Set(hosts).size).toBe(hosts.length);
		for (const host of hosts) {
			expect(typeof host).toBe("string");
			expect(host.length).toBeGreaterThan(0);
			expect(isLoopbackHost(host)).toBe(false);
			expect(isWildcardBindHost(host)).toBe(false);
		}
	});
});
