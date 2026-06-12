// Proxy URL assembly and environment variable injection utilities.
// Converts split proxy config fields (host, port, username, password) into
// a complete proxy URL and a record of standard HTTP_PROXY / HTTPS_PROXY
// environment variables that callers merge into CHILD process spawns.
//
// NOTE: nothing here mutates the runtime's OWN process.env. Writing proxy URLs
// into the runtime process permanently latches Bun's in-process fetch (see
// config/proxy-fetch.ts), which is why proxy delivery to subprocesses is done
// via explicit per-spawn env merges using buildProxyEnvVars / the holder, not
// by polluting process.env.

export function buildProxyUrl(host: string, port: string, username: string, password: string): string {
	const trimmedHost = host.trim();
	if (!trimmedHost) return "";
	const trimmedPort = port.trim();
	const trimmedUsername = username.trim();
	const trimmedPassword = password.trim();
	let auth = "";
	if (trimmedUsername) {
		const encodedUser = encodeURIComponent(trimmedUsername);
		auth = trimmedPassword ? `${encodedUser}:${encodeURIComponent(trimmedPassword)}@` : `${encodedUser}@`;
	}
	const portPart = trimmedPort ? `:${trimmedPort}` : "";
	return `http://${auth}${trimmedHost}${portPart}`;
}

// Loopback hosts that should never be routed through an outbound proxy.
// Kept here (rather than in the runtime layer) so proxy-env stays a leaf util.
export const LOOPBACK_NO_PROXY_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

/**
 * Merges additional hosts into an existing NO_PROXY-style comma list.
 * Existing entries are preserved in order; additions are appended.
 * Entries are trimmed, empty entries dropped, and duplicates removed
 * case-insensitively (keeping the first occurrence). Idempotent.
 */
export function mergeNoProxyEntries(existing: string | null | undefined, additions: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	const push = (raw: string): void => {
		const value = raw.trim();
		if (!value) return;
		const key = value.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		result.push(value);
	};
	for (const part of (existing ?? "").split(",")) push(part);
	for (const addition of additions) push(addition);
	return result.join(",");
}

// Prefix marking a no-proxy entry as a JavaScript regular expression rather than
// an equality/subdomain-suffix host rule. Matched case-insensitively.
const REGEX_NO_PROXY_PREFIX = "re:";

/**
 * If `entry` is a `re:`-prefixed regex rule, returns its (trimmed) pattern body
 * — possibly empty. Returns `null` for ordinary equality/suffix entries. The
 * prefix is recognized case-insensitively; the pattern body keeps its original
 * case so character classes like `\d` vs `\D` are not corrupted.
 */
function parseRegexNoProxyEntry(trimmedEntry: string): string | null {
	if (trimmedEntry.length < REGEX_NO_PROXY_PREFIX.length) return null;
	const prefix = trimmedEntry.slice(0, REGEX_NO_PROXY_PREFIX.length).toLowerCase();
	if (prefix !== REGEX_NO_PROXY_PREFIX) return null;
	return trimmedEntry.slice(REGEX_NO_PROXY_PREFIX.length).trim();
}

/**
 * Decides whether a request to `host` should bypass the outbound proxy,
 * following NO_PROXY conventions. Loopback hosts always bypass. A `*` entry
 * bypasses everything. A `re:<pattern>` entry bypasses when the case-insensitive
 * regex matches the host (an invalid or empty pattern is skipped safely, never
 * throwing and never matching). Any other entry matches when the host equals it
 * or is a subdomain of it (boundary-aware, leading dot tolerated), all
 * case-insensitively. `host` may carry IPv6 brackets (as URL.hostname does).
 */
export function shouldBypassProxy(host: string, noProxyList: string | null | undefined): boolean {
	const normalizedHost = host
		.trim()
		.replace(/^\[|\]$/g, "")
		.toLowerCase();
	if (!normalizedHost) return true;
	if ((LOOPBACK_NO_PROXY_HOSTS as readonly string[]).includes(normalizedHost)) return true;
	for (const rawEntry of (noProxyList ?? "").split(",")) {
		const trimmed = rawEntry.trim();
		if (!trimmed) continue;
		const regexPattern = parseRegexNoProxyEntry(trimmed);
		if (regexPattern !== null) {
			if (!regexPattern) continue;
			let regex: RegExp | null = null;
			try {
				regex = new RegExp(regexPattern, "i");
			} catch {
				regex = null;
			}
			if (regex?.test(normalizedHost)) return true;
			continue;
		}
		const entry = trimmed.toLowerCase();
		if (entry === "*") return true;
		const suffix = entry.replace(/^\./, "").replace(/^\[|\]$/g, "");
		if (!suffix) continue;
		if (normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

// The four proxy-URL environment variable keys (both cases). Deliberately
// excludes NO_PROXY/no_proxy: only a proxy URL latches Bun's in-process fetch,
// so the runtime strips exactly these at boot (see config/proxy-fetch.ts) while
// preserving any inherited NO_PROXY.
export const PROXY_URL_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/**
 * Builds the proxy environment record from an already-assembled proxy URL and an
 * already-merged NO_PROXY list. Returns `{}` when the URL is empty. This is the
 * shared core used both by `buildProxyEnvVars` (discrete config fields) and by
 * the proxy holder's subprocess-env builder, so there is a single source of the
 * env-var shape.
 */
export function buildProxyEnvVarsFromUrl(proxyUrl: string, noProxy: string): Record<string, string> {
	if (!proxyUrl) return {};
	const vars: Record<string, string> = {
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
	};
	if (noProxy) {
		vars.NO_PROXY = noProxy;
		vars.no_proxy = noProxy;
	}
	return vars;
}

export function buildProxyEnvVars(
	enabled: boolean,
	host: string,
	port: string,
	username: string,
	password: string,
	noProxy: string,
	extraNoProxyHosts: readonly string[] = [],
): Record<string, string> {
	if (!enabled) return {};
	const url = buildProxyUrl(host, port, username, password);
	if (!url) return {};
	return buildProxyEnvVarsFromUrl(url, mergeNoProxyEntries(noProxy, extraNoProxyHosts));
}
