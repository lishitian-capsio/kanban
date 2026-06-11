// In-process outbound-proxy interceptor for live proxy switching.
//
// WHY A MONKEY-PATCH (CLAUDE.md discourages it):
// Kanban has no single choke point for outbound traffic. Provider SDK calls,
// ~26 bare `fetch()` OAuth/token exchanges, and model-discovery all ultimately
// reach `globalThis.fetch`, but most have no dependency-injection seam for a
// custom fetch. Threading a fetch parameter through 40+ call sites would be
// large and fragile. Patching `globalThis.fetch` once, at boot, is the only
// way to cover them uniformly. The codebase already sanctions this pattern via
// `agent-sdk/shared/hook-fetch.ts`.
//
// Changing HTTP_PROXY/HTTPS_PROXY in process.env does NOT work for in-process
// requests: Bun's global fetch ignores those env vars (only the per-request
// `{ proxy }` option works) and Node/undici's global fetch ignores them too.
// So we read a mutable holder at request time and inject the proxy via the
// engine-native mechanism: Bun -> `{ proxy }`, Node -> `{ dispatcher: ProxyAgent }`.
//
// Subprocess agent sessions are unaffected: they still inherit proxy settings
// through env vars computed at spawn time (see config/proxy-env.ts) and are out
// of scope here.
//
// The interceptor is transparent when no proxy is enabled (plain passthrough),
// respects a caller-provided `dispatcher`/`proxy`, and never proxies loopback
// or NO_PROXY hosts (keeping runtime self-communication direct).

import { ProxyAgent } from "undici";
import { buildProxyUrl, mergeNoProxyEntries, shouldBypassProxy } from "./proxy-env";

export interface RuntimeProxyState {
	enabled: boolean;
	/** Fully-assembled proxy URL (see buildProxyUrl), or "" when none. */
	proxyUrl: string;
	/** NO_PROXY-style comma list, already merged with runtime self-hosts. */
	noProxy: string;
}

const state: RuntimeProxyState = { enabled: false, proxyUrl: "", noProxy: "" };

export function setRuntimeProxyState(next: RuntimeProxyState): void {
	state.enabled = next.enabled;
	state.proxyUrl = next.proxyUrl;
	state.noProxy = next.noProxy;
}

export function getRuntimeProxyState(): Readonly<RuntimeProxyState> {
	return state;
}

/**
 * Updates the in-process proxy holder from the same discrete config fields that
 * `applyProxyToProcessEnv` consumes, so both can be called side-by-side at the
 * save and startup sites. The proxy is treated as disabled whenever the flag is
 * off or the assembled URL is empty.
 */
export function setRuntimeProxyStateFromConfig(
	enabled: boolean,
	host: string,
	port: string,
	username: string,
	password: string,
	noProxy: string,
	extraNoProxyHosts: readonly string[] = [],
): void {
	const proxyUrl = buildProxyUrl(host, port, username, password);
	setRuntimeProxyState({
		enabled: enabled && proxyUrl !== "",
		proxyUrl,
		noProxy: mergeNoProxyEntries(noProxy, extraNoProxyHosts),
	});
}

const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Single-slot ProxyAgent cache (Node only). Reused across requests; rebuilt and
// the previous one closed whenever the proxy URL changes.
let cachedAgentUrl: string | null = null;
let cachedAgent: ProxyAgent | null = null;

function getProxyAgent(url: string): ProxyAgent {
	if (cachedAgent && cachedAgentUrl === url) return cachedAgent;
	if (cachedAgent) void cachedAgent.close().catch(() => {});
	cachedAgent = new ProxyAgent(url);
	cachedAgentUrl = url;
	return cachedAgent;
}

function extractHost(input: string | URL | Request): string {
	try {
		if (typeof input === "string") return new URL(input).hostname;
		if (input instanceof URL) return input.hostname;
		if (input instanceof Request) return new URL(input.url).hostname;
		return new URL(String((input as { url?: string }).url ?? input)).hostname;
	} catch {
		return "";
	}
}

/**
 * Returns the init to forward to the underlying fetch. When the proxy applies,
 * a shallow-cloned init carries the engine-native proxy field; otherwise the
 * original init reference is returned untouched.
 */
function decorateInitWithProxy(init: RequestInit | undefined, proxyUrl: string): RequestInit {
	if (isBunRuntime) {
		return { ...init, proxy: proxyUrl } as RequestInit;
	}
	return { ...init, dispatcher: getProxyAgent(proxyUrl) } as RequestInit;
}

let installed = false;
let originalFetch: typeof globalThis.fetch | null = null;

export function installProxyFetch(): void {
	if (installed) return;
	originalFetch = globalThis.fetch;
	const original = originalFetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		if (!state.enabled || !state.proxyUrl) return original(input, init);
		// Respect an explicit transport the caller already chose (e.g. the
		// CA-pinned dispatcher from getRuntimeFetch).
		const explicit = init as { dispatcher?: unknown; proxy?: unknown } | undefined;
		if (explicit?.dispatcher !== undefined || explicit?.proxy !== undefined) {
			return original(input, init);
		}
		if (shouldBypassProxy(extractHost(input), state.noProxy)) return original(input, init);
		return original(input, decorateInitWithProxy(init, state.proxyUrl));
	}) as typeof globalThis.fetch;
	installed = true;
}

export function uninstallProxyFetch(): void {
	if (!installed || !originalFetch) return;
	globalThis.fetch = originalFetch;
	originalFetch = null;
	installed = false;
	if (cachedAgent) {
		void cachedAgent.close().catch(() => {});
		cachedAgent = null;
		cachedAgentUrl = null;
	}
}
