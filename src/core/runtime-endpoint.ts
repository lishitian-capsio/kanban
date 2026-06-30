import { networkInterfaces } from "node:os";
import { rootCertificates } from "node:tls";
import { Agent } from "undici";
import { LOOPBACK_NO_PROXY_HOSTS, mergeNoProxyEntries } from "../config/proxy-env";
import { getInternalTokenFilePath, readPersistedInternalToken } from "../security/internal-token-store";
import { getInternalToken } from "../security/passcode-manager";

export const DEFAULT_KANBAN_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_KANBAN_RUNTIME_PORT = 3484;
const KANBAN_RUNTIME_HTTPS_ENV = "KANBAN_RUNTIME_HTTPS";
const KANBAN_RUNTIME_TLS_CA_ENV = "KANBAN_RUNTIME_TLS_CA";
const KANBAN_RUNTIME_ALLOWED_HOSTS_ENV = "KANBAN_RUNTIME_ALLOWED_HOSTS";

let runtimeHost: string = process.env.KANBAN_RUNTIME_HOST?.trim() || DEFAULT_KANBAN_RUNTIME_HOST;

/**
 * The hosts that always reach the Kanban runtime over loopback/self: the
 * standard loopback aliases plus whatever host the runtime is bound to.
 * Used to keep self-communication off any outbound HTTP proxy.
 */
export function getKanbanRuntimeNoProxyHosts(): string[] {
	return [...LOOPBACK_NO_PROXY_HOSTS, runtimeHost];
}

/**
 * Ensures the runtime self-hosts are present in this process's NO_PROXY /
 * no_proxy env so Bun's (and Node's) global fetch never routes
 * CLI/hook -> runtime self-communication through an inherited HTTP_PROXY.
 * Idempotent and non-destructive: existing user entries are preserved.
 */
function ensureRuntimeHostBypassesProxy(): void {
	const hosts = getKanbanRuntimeNoProxyHosts();
	process.env.NO_PROXY = mergeNoProxyEntries(process.env.NO_PROXY, hosts);
	process.env.no_proxy = mergeNoProxyEntries(process.env.no_proxy, hosts);
}

// Apply on module load so CLI/hook sub-processes — which learn the bound host
// from KANBAN_RUNTIME_HOST and never run the server proxy-env setup — still
// bypass the proxy for self-communication.
ensureRuntimeHostBypassesProxy();

export function getKanbanRuntimeHost(): string {
	return runtimeHost;
}

export function setKanbanRuntimeHost(host: string): void {
	runtimeHost = host;
	process.env.KANBAN_RUNTIME_HOST = host;
	ensureRuntimeHostBypassesProxy();
}

export function parseRuntimePort(rawPort: string | undefined): number {
	if (!rawPort) {
		return DEFAULT_KANBAN_RUNTIME_PORT;
	}
	const parsed = Number.parseInt(rawPort, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid KANBAN_RUNTIME_PORT value "${rawPort}". Expected an integer from 1-65535.`);
	}
	return parsed;
}

/**
 * Parsed `--port` CLI value: a fixed integer port or the literal `auto` (pick a free
 * port at boot). This is the single source of truth for the `--port` option shared by
 * the root `serve` command and `service install` (design doc §6.1, removes I7's divergent
 * `parseServicePort`).
 */
export type RuntimePortOption = { mode: "fixed"; value: number } | { mode: "auto" };

/** Parse a `--port` CLI value: an integer from 1-65535 or the literal `"auto"`. */
export function parseCliPortOption(rawValue: string): RuntimePortOption {
	const normalized = rawValue.trim().toLowerCase();
	if (!normalized) {
		throw new Error("Missing value for --port.");
	}
	if (normalized === "auto") {
		return { mode: "auto" };
	}
	try {
		return { mode: "fixed", value: parseRuntimePort(normalized) };
	} catch {
		throw new Error(`Invalid port value: ${rawValue}. Expected an integer from 1-65535 or "auto".`);
	}
}

let runtimePort = parseRuntimePort(process.env.KANBAN_RUNTIME_PORT?.trim());

export function getKanbanRuntimePort(): number {
	return runtimePort;
}

export function setKanbanRuntimePort(port: number): void {
	const normalized = parseRuntimePort(String(port));
	runtimePort = normalized;
	process.env.KANBAN_RUNTIME_PORT = String(normalized);
}

export interface RuntimeTlsConfig {
	cert: string;
	key: string;
	ca?: string;
}

let runtimeTls: RuntimeTlsConfig | null = null;
let runtimeTlsCa: string | null = process.env[KANBAN_RUNTIME_TLS_CA_ENV]?.trim() || null;

/**
 * Whether the runtime is served over HTTPS. Initialised from the
 * `KANBAN_RUNTIME_HTTPS` env var so that CLI sub-commands (which run
 * in a separate process from the server) know the correct scheme.
 */
let runtimeHttps: boolean = process.env[KANBAN_RUNTIME_HTTPS_ENV] === "1";

function clearRuntimeFetchCache(): void {
	_runtimeFetchPromise = undefined;
}

export function getKanbanRuntimeTls(): RuntimeTlsConfig | null {
	return runtimeTls;
}

export function setKanbanRuntimeTls(tls: RuntimeTlsConfig): void {
	runtimeTls = tls;
	runtimeHttps = true;
	runtimeTlsCa = tls.ca?.trim() || null;
	process.env[KANBAN_RUNTIME_HTTPS_ENV] = "1";
	if (runtimeTlsCa) {
		process.env[KANBAN_RUNTIME_TLS_CA_ENV] = runtimeTlsCa;
	} else {
		delete process.env[KANBAN_RUNTIME_TLS_CA_ENV];
	}
	clearRuntimeFetchCache();
}

export function clearKanbanRuntimeTls(): void {
	runtimeTls = null;
	runtimeTlsCa = null;
	runtimeHttps = false;
	delete process.env[KANBAN_RUNTIME_HTTPS_ENV];
	delete process.env[KANBAN_RUNTIME_TLS_CA_ENV];
	clearRuntimeFetchCache();
}

export function isKanbanRuntimeHttps(): boolean {
	return runtimeHttps;
}

const LOCALHOST_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The IPv4/IPv6 "any address" bind targets. These are *bind* addresses, never
 * values a client sends in a `Host` header, so they must never be used as a
 * Host/Origin allowlist entry on their own — doing so self-locks the server
 * (the browser reaches it via a concrete NIC IP, which would be rejected).
 */
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", ""]);

/**
 * True when `host` is one of the loopback aliases (always reachable over self).
 */
export function isLoopbackHost(host: string): boolean {
	return LOCALHOST_HOSTS.has(host.trim().toLowerCase());
}

/**
 * True when `host` is a wildcard ("any address") bind target (`0.0.0.0`, `::`,
 * or empty). The runtime listens on every interface but clients connect via a
 * concrete address, so allowlists must enumerate the real NIC IPs instead.
 */
export function isWildcardBindHost(host: string): boolean {
	return WILDCARD_BIND_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Whether a host is a link-local address (IPv6 `fe80::/10` or IPv4
 * `169.254.0.0/16`). These are excluded from shareable access URL lists
 * because they usually need an interface scope and are poor copy/paste targets.
 */
export function isLinkLocalHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return /^fe[89ab][0-9a-f]:/.test(normalized) || normalized.startsWith("169.254.");
}

/**
 * Whether a given bind host is "remote" (non-localhost), meaning the runtime is
 * reachable by other machines and passcode auth applies. Pure helper so callers
 * that know a host out-of-band (e.g. `kanban service install --host`) can decide
 * remoteness without mutating module state.
 */
export function isRemoteRuntimeHost(host: string): boolean {
	return !LOCALHOST_HOSTS.has(host);
}

/**
 * Returns true when Kanban is bound to a non-localhost host, meaning it is
 * accessible to other machines on the network and passcode auth is required.
 */
export function isKanbanRemoteHost(): boolean {
	return isRemoteRuntimeHost(runtimeHost);
}

/**
 * Operator-configured extra hosts (comma-separated `KANBAN_RUNTIME_ALLOWED_HOSTS`)
 * to accept in the `Host`/`Origin` allowlist — e.g. a domain name or an
 * additional IP that resolves to this machine. Entries are bare hostnames/IPs;
 * the runtime port is appended when building the allowlist.
 */
export function getKanbanRuntimeAllowedHosts(): string[] {
	const raw = process.env[KANBAN_RUNTIME_ALLOWED_HOSTS_ENV];
	if (!raw) {
		return [];
	}
	return raw
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host.length > 0);
}

/**
 * Enumerates this machine's non-internal network interface addresses (IPv4 and
 * IPv6, de-duplicated, lowercased, with any IPv6 zone id stripped). Used to
 * populate the Host/Origin allowlist when bound to a wildcard address so a
 * browser hitting the box via its LAN IP is accepted instead of self-locked.
 */
export function getLocalNetworkHosts(): string[] {
	const hosts: string[] = [];
	const seen = new Set<string>();
	for (const addresses of Object.values(networkInterfaces())) {
		if (!addresses) {
			continue;
		}
		for (const info of addresses) {
			if (info.internal) {
				continue;
			}
			const zoneIndex = info.address.indexOf("%");
			const address = (zoneIndex === -1 ? info.address : info.address.slice(0, zoneIndex)).toLowerCase();
			if (!address || seen.has(address)) {
				continue;
			}
			seen.add(address);
			hosts.push(address);
		}
	}
	return hosts;
}

export function getKanbanRuntimeOrigin(): string {
	const scheme = isKanbanRuntimeHttps() ? "https" : "http";
	return `${scheme}://${getKanbanRuntimeHost()}:${getKanbanRuntimePort()}`;
}

export function getKanbanRuntimeWsOrigin(): string {
	const scheme = isKanbanRuntimeHttps() ? "wss" : "ws";
	return `${scheme}://${getKanbanRuntimeHost()}:${getKanbanRuntimePort()}`;
}

export function buildKanbanRuntimeUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getKanbanRuntimeOrigin()}${normalizedPath}`;
}

export interface RuntimeAccessUrlsInput {
	host: string;
	port: number;
	https: boolean;
	localNetworkHosts: readonly string[];
	pathname?: string;
}

function formatUrlHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

/**
 * Build the ordered, de-duplicated list of browser access URLs for a runtime
 * bind. Wildcard bind addresses (`0.0.0.0` / `::`) are not client destinations,
 * so this enumerates concrete NIC addresses instead and keeps loopback as a
 * fallback. Remote/NIC URLs come first because those are the shareable ones.
 */
export function buildKanbanRuntimeAccessUrls(input: RuntimeAccessUrlsInput): string[] {
	const scheme = input.https ? "https" : "http";
	const normalizedPath =
		input.pathname && input.pathname.length > 0
			? input.pathname.startsWith("/")
				? input.pathname
				: `/${input.pathname}`
			: "";
	const urls: string[] = [];
	const seen = new Set<string>();
	const push = (host: string): void => {
		const trimmed = host.trim();
		if (!trimmed) {
			return;
		}
		const url = `${scheme}://${formatUrlHost(trimmed)}:${input.port}${normalizedPath}`;
		if (seen.has(url)) {
			return;
		}
		seen.add(url);
		urls.push(url);
	};

	if (!isLoopbackHost(input.host)) {
		if (isWildcardBindHost(input.host)) {
			for (const host of input.localNetworkHosts) {
				if (!isLinkLocalHost(host)) {
					push(host);
				}
			}
		} else {
			push(input.host);
		}
	}
	push("127.0.0.1");
	return urls;
}

export function getKanbanRuntimeAccessUrls(pathname?: string): string[] {
	const host = getKanbanRuntimeHost();
	return buildKanbanRuntimeAccessUrls({
		host,
		port: getKanbanRuntimePort(),
		https: isKanbanRuntimeHttps(),
		localNetworkHosts: isWildcardBindHost(host) ? getLocalNetworkHosts() : [],
		pathname,
	});
}

export function getKanbanRuntimePrimaryAccessUrl(pathname?: string): string {
	return getKanbanRuntimeAccessUrls(pathname)[0] ?? buildKanbanRuntimeUrl(pathname ?? "/");
}

export function buildKanbanRuntimeWsUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getKanbanRuntimeWsOrigin()}${normalizedPath}`;
}

/**
 * A fetch function that trusts the configured Kanban runtime certificate
 * bundle when connecting to the runtime over HTTPS, and automatically
 * attaches the internal CLI auth token (when present) so that CLI
 * sub-processes can authenticate against the runtime server without the
 * browser passcode flow.
 *
 * When HTTPS is not enabled and no internal token exists, this simply
 * returns the global fetch.
 */
let _runtimeFetchPromise: Promise<typeof globalThis.fetch> | undefined;

export function getRuntimeFetch(): Promise<typeof globalThis.fetch> {
	_runtimeFetchPromise ??= (async () => {
		let baseFetch: typeof globalThis.fetch = globalThis.fetch;

		if (isKanbanRuntimeHttps() && runtimeTlsCa) {
			const dispatcher = new Agent({
				connect: {
					ca: [...rootCertificates, runtimeTlsCa].join("\n"),
				},
			});
			baseFetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
				globalThis.fetch(url, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;
		}

		// Wrap the base fetch to inject the internal CLI auth bearer token when one
		// is available. Daemon-spawned children inherit it via the env var; a CLI/
		// hook process launched independently of the daemon has no env token, so
		// fall back to the machine-local persisted token (same value the server
		// reuses across restarts) — without it such a process can never authenticate.
		const internalToken = getInternalToken() ?? (await readPersistedInternalToken(getInternalTokenFilePath()));
		if (!internalToken) {
			return baseFetch;
		}

		const wrappedFetch = baseFetch;
		return ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const headers = new Headers(init?.headers);
			if (!headers.has("Authorization")) {
				headers.set("Authorization", `Bearer ${internalToken}`);
			}
			return wrappedFetch(url, { ...init, headers });
		}) as typeof globalThis.fetch;
	})();
	return _runtimeFetchPromise;
}
