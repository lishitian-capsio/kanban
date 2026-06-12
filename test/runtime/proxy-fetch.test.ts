import { ProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getRuntimeProxyState,
	installProxyFetch,
	setRuntimeProxyState,
	setRuntimeProxyStateFromConfig,
	uninstallProxyFetch,
} from "../../src/config/proxy-fetch";

const PROXY_URL = "http://127.0.0.1:59999";
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

function lastInit(fake: ReturnType<typeof vi.fn>): RequestInit | undefined {
	return fake.mock.calls.at(-1)?.[1] as RequestInit | undefined;
}

function expectProxied(init: RequestInit | undefined, url: string): void {
	if (isBun) {
		expect((init as { proxy?: string } | undefined)?.proxy).toBe(url);
	} else {
		expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeInstanceOf(ProxyAgent);
	}
}

function expectDirect(init: RequestInit | undefined): void {
	expect((init as { proxy?: string } | undefined)?.proxy).toBeUndefined();
	expect((init as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
}

describe("proxy-fetch interceptor", () => {
	let realFetch: typeof globalThis.fetch;
	let fake: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		fake = vi.fn(async () => new Response("ok"));
		globalThis.fetch = fake as unknown as typeof globalThis.fetch;
		installProxyFetch();
	});

	afterEach(() => {
		uninstallProxyFetch();
		globalThis.fetch = realFetch;
		setRuntimeProxyState({ enabled: false, proxyUrl: "", noProxy: "" });
	});

	it("passes through unchanged when proxy is disabled", async () => {
		setRuntimeProxyState({ enabled: false, proxyUrl: "", noProxy: "" });
		await globalThis.fetch("https://api.openai.com/v1/models");
		expect(fake).toHaveBeenCalledTimes(1);
		expectDirect(lastInit(fake));
	});

	it("injects the proxy for an external host when enabled", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "localhost,127.0.0.1" });
		await globalThis.fetch("https://api.openai.com/v1/models");
		expectProxied(lastInit(fake), PROXY_URL);
	});

	it("does not proxy a host that matches NO_PROXY", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "localhost,corp.internal" });
		await globalThis.fetch("https://api.corp.internal/v1/models");
		expectDirect(lastInit(fake));
	});

	it("connects directly to a host matched by a re: NO_PROXY regex (mainland MaaS endpoint)", async () => {
		// Regression: mainland provider endpoints were forced through an overseas
		// proxy that can't reach them, making /models discovery fail and retry-flood.
		setRuntimeProxyState({
			enabled: true,
			proxyUrl: PROXY_URL,
			noProxy: "localhost,127.0.0.1,re:\\.aliyuncs\\.com$",
		});
		await globalThis.fetch("https://token-plan.cn-beijing.maas.aliyuncs.com/v1/models");
		expectDirect(lastInit(fake));
		// A non-matching external host still goes through the proxy.
		await globalThis.fetch("https://api.openai.com/v1/models");
		expectProxied(lastInit(fake), PROXY_URL);
	});

	it("never proxies loopback self-communication", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "" });
		await globalThis.fetch("http://127.0.0.1:3484/trpc/health");
		expectDirect(lastInit(fake));
	});

	it("respects a caller-provided dispatcher and does not override it", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "" });
		const callerDispatcher = new ProxyAgent("http://127.0.0.1:1");
		await globalThis.fetch("https://api.openai.com/v1/models", {
			dispatcher: callerDispatcher,
		} as RequestInit);
		expect((lastInit(fake) as { dispatcher?: unknown }).dispatcher).toBe(callerDispatcher);
		await callerDispatcher.close();
	});

	it("switches live without re-installing: enable then disable", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "" });
		await globalThis.fetch("https://api.openai.com/v1/models");
		expectProxied(lastInit(fake), PROXY_URL);

		setRuntimeProxyState({ enabled: false, proxyUrl: "", noProxy: "" });
		await globalThis.fetch("https://api.openai.com/v1/models");
		expectDirect(lastInit(fake));
	});

	it("derives state from discrete config fields and merges extra no-proxy hosts", () => {
		setRuntimeProxyStateFromConfig(true, "proxy.local", "7897", "", "", "corp.internal", ["127.0.0.1"]);
		const s = getRuntimeProxyState();
		expect(s.enabled).toBe(true);
		expect(s.proxyUrl).toBe("http://proxy.local:7897");
		expect(s.noProxy).toBe("corp.internal,127.0.0.1");
	});

	it("treats an empty host or disabled flag as disabled", () => {
		setRuntimeProxyStateFromConfig(true, "", "7897", "", "", "", []);
		expect(getRuntimeProxyState().enabled).toBe(false);
		setRuntimeProxyStateFromConfig(false, "proxy.local", "7897", "", "", "", []);
		expect(getRuntimeProxyState().enabled).toBe(false);
	});

	it("accepts URL and Request inputs", async () => {
		setRuntimeProxyState({ enabled: true, proxyUrl: PROXY_URL, noProxy: "" });
		await globalThis.fetch(new URL("https://api.openai.com/v1/models"));
		expectProxied(lastInit(fake), PROXY_URL);
		await globalThis.fetch(new Request("https://api.openai.com/v1/models"));
		expectProxied(lastInit(fake), PROXY_URL);
	});
});
