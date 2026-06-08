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
		auth = trimmedPassword
			? `${encodedUser}:${encodeURIComponent(trimmedPassword)}@`
			: `${encodedUser}@`;
	}
	const portPart = trimmedPort ? `:${trimmedPort}` : "";
	return `http://${auth}${trimmedHost}${portPart}`;
}

export function buildProxyEnvVars(
	enabled: boolean,
	host: string,
	port: string,
	username: string,
	password: string,
	noProxy: string,
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
	const trimmedNoProxy = noProxy.trim();
	if (trimmedNoProxy) {
		vars.NO_PROXY = trimmedNoProxy;
		vars.no_proxy = trimmedNoProxy;
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
	const trimmedNoProxy = noProxy.trim();
	if (trimmedNoProxy) {
		process.env.NO_PROXY = trimmedNoProxy;
		process.env.no_proxy = trimmedNoProxy;
	} else {
		delete process.env.NO_PROXY;
		delete process.env.no_proxy;
	}
}
