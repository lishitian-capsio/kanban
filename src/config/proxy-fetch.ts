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
// WHY WE CANNOT DRIVE IN-PROCESS ROUTING VIA process.env:
// Bun 1.3.x's global fetch DOES honor HTTP(S)_PROXY env, but it latches the
// value on the first outbound fetch and caches it for the process lifetime.
// After that latch, deleting the env var does NOT undo it, switching it to a
// different proxy does NOT change routing, and `fetch(url, { proxy: "" })` does
// NOT force direct (it falls back to the latched value). Node/undici's global
// fetch ignores the env entirely. So env can never give us live switching.
//
// Therefore the holder is the SINGLE source of truth for the runtime's own
// outbound requests. Two guarantees keep it authoritative:
//   1. `stripInheritedProxyEnv()` runs at boot (inside installProxyFetch, before
//      the first fetch) to clear any shell-inherited proxy URL so Bun latches
//      "direct". NO_PROXY is left intact.
//   2. The runtime never writes proxy URLs back into its own process.env.
// With Bun latched direct, every request is routed purely by the per-request
// engine-native option we inject: Bun -> `{ proxy }`, Node -> `{ dispatcher }`.
//
// Subprocess agent sessions are unaffected: they get proxy settings through env
// vars built at spawn time. Terminal sessions assemble them from per-session
// config (config/proxy-env.ts `buildProxyEnvVars`); other runtime-side spawns
// merge `buildSubprocessProxyEnv()`, which reads this same holder.
//
// The interceptor is transparent when no proxy is enabled (plain passthrough,
// which is now genuinely direct), respects a caller-provided `dispatcher`/
// `proxy`, and never proxies loopback or NO_PROXY hosts.

import { ProxyAgent } from "undici";
import {
	buildProxyEnvVarsFromUrl,
	buildProxyUrl,
	mergeNoProxyEntries,
	PROXY_URL_ENV_KEYS,
	shouldBypassProxy,
} from "./proxy-env";

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
 * Builds the proxy environment record for a CHILD process spawn from the current
 * holder state. Returns `{}` when the proxy is disabled. Runtime-side spawns that
 * previously relied on inherited `process.env` proxy vars (e.g. self-update,
 * shortcut commands) merge this into the child's env so they keep routing through
 * the configured proxy even though the runtime's own process.env stays clean.
 */
export function buildSubprocessProxyEnv(): Record<string, string> {
	if (!state.enabled || !state.proxyUrl) return {};
	return buildProxyEnvVarsFromUrl(state.proxyUrl, state.noProxy);
}

/**
 * Neutralizes inherited proxy-URL env vars (HTTP(S)_PROXY, both cases) on the
 * runtime's own process.env so Bun's in-process fetch latches "direct" on its
 * first request, leaving the holder as the sole in-process proxy control.
 *
 * Critically, the vars are set to "" rather than deleted: Bun captures the proxy
 * from the boot environment and `delete` does NOT un-latch it (a no-option fetch
 * falls back to the boot value), but assigning an empty string IS honored as
 * "no proxy" and overrides the boot capture. NO_PROXY/no_proxy are left intact
 * (they don't latch a proxy and are needed for CLI/hook self-communication
 * bypass). Returns the captured original values for one-time startup logging.
 */
export function stripInheritedProxyEnv(): { http?: string; https?: string } {
	const captured = {
		http: process.env.HTTP_PROXY ?? process.env.http_proxy,
		https: process.env.HTTPS_PROXY ?? process.env.https_proxy,
	};
	for (const key of PROXY_URL_ENV_KEYS) process.env[key] = "";
	return captured;
}

/**
 * Updates the in-process proxy holder from the discrete config fields. Called at
 * the save and startup sites; the holder is the single source of truth for the
 * runtime's own outbound requests. The proxy is treated as disabled whenever the
 * flag is off or the assembled URL is empty.
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

/**
 * Installs the interceptor and strips inherited proxy URL env BEFORE the first
 * fetch (so Bun latches "direct" and the holder becomes the sole in-process
 * control — see file header). Returns the captured inherited proxy values so the
 * caller can emit a one-time startup notice. Idempotent; the strip and capture
 * happen only on the first call.
 */
export function installProxyFetch(): { http?: string; https?: string } {
	if (installed) return {};
	const captured = stripInheritedProxyEnv();
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
	return captured;
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
