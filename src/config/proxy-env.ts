// Proxy URL assembly and environment variable injection utilities.
// Converts split proxy config fields (host, port, username, password) into
// a complete proxy URL and injects it as standard HTTP_PROXY / HTTPS_PROXY
// environment variables into agent sessions and the runtime process.

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
	const vars: Record<string, string> = {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
	};
	const mergedNoProxy = mergeNoProxyEntries(noProxy, extraNoProxyHosts);
	if (mergedNoProxy) {
		vars.NO_PROXY = mergedNoProxy;
		vars.no_proxy = mergedNoProxy;
	}
	return vars;
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"];

export function applyProxyToProcessEnv(
	enabled: boolean,
	host: string,
	port: string,
	username: string,
	password: string,
	noProxy: string,
	extraNoProxyHosts: readonly string[] = [],
): void {
	if (!enabled) {
		for (const key of PROXY_ENV_KEYS) delete process.env[key];
		return;
	}
	const url = buildProxyUrl(host, port, username, password);
	if (!url) {
		for (const key of PROXY_ENV_KEYS) delete process.env[key];
		return;
	}
	process.env.HTTP_PROXY = url;
	process.env.HTTPS_PROXY = url;
	process.env.http_proxy = url;
	process.env.https_proxy = url;
	const mergedNoProxy = mergeNoProxyEntries(noProxy, extraNoProxyHosts);
	if (mergedNoProxy) {
		process.env.NO_PROXY = mergedNoProxy;
		process.env.no_proxy = mergedNoProxy;
	} else {
		delete process.env.NO_PROXY;
		delete process.env.no_proxy;
	}
}
