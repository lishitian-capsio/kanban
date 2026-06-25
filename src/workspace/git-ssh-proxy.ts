// SSH-over-proxy support for git network ops.
//
// WHY THIS IS SEPARATE FROM THE HTTP PROXY ENV (config/proxy-env.ts):
// git's http(s) transport honors HTTP_PROXY/HTTPS_PROXY natively, so routing it
// through Kanban's configured proxy is just an env merge (see git-utils.ts).
// SSH remotes do NOT: OpenSSH has no built-in HTTP-CONNECT proxy support, so the
// only way to tunnel `git@host:…` through Kanban's (always-HTTP) proxy is to set
// `GIT_SSH_COMMAND="ssh -o ProxyCommand=<connect-helper>"`, where the helper
// speaks HTTP CONNECT and ssh expands `%h`/`%p` to the target host/port.
//
// HELPER STRATEGY (auto-detect, graceful fallback):
// No CONNECT helper ships with OpenSSH, so we probe PATH for the common ones in
// priority order and use the first available. socat and ncat carry proxy auth
// inline (no on-disk secret); corkscrew is the classic SSH-over-HTTP helper but
// its auth needs a file, so it is only used for an unauthenticated proxy. When
// none is installed we leave SSH unproxied and warn once — never break SSH.
//
// SECRET HANDLING: the proxy password (if any) lands inline in the GIT_SSH_COMMAND
// of the git SUBPROCESS env only — never written to disk, never into the runtime's
// own process.env. This matches how the HTTP path already passes user:pass inside
// the HTTP_PROXY URL to subprocesses (config/proxy-env.ts).
//
// LIMITATION: GIT_SSH_COMMAND is process-wide and the target host is unknown at
// env-build time (ssh resolves `%h` later), so NO_PROXY / loopback bypass is NOT
// applied to SSH remotes — every ssh invocation from a proxied git op goes through
// the proxy. The http(s) path still honors NO_PROXY. SOCKS proxies are out of
// scope (Kanban only assembles http:// proxy URLs today).

import { getRuntimeProxyState } from "../config/proxy-fetch";
import { createLogger } from "../logging";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";

const log = createLogger("git-ssh-proxy");

export interface SshProxyTarget {
	host: string;
	port: string;
	username: string;
	password: string;
}

export interface SshProxyHelper {
	/** Binary name probed on PATH. */
	command: string;
	/**
	 * Whether this helper can carry proxy credentials inline (no on-disk secret).
	 * Helpers that can't are skipped for an authenticated proxy.
	 */
	supportsInlineAuth: boolean;
	/**
	 * Builds the value passed to `ssh -o ProxyCommand=…`. `%h`/`%p` are ssh tokens
	 * (target host/port), expanded by ssh — not by the shell — so they pass through.
	 */
	buildProxyCommand(target: SshProxyTarget): string;
}

// Priority order. socat/ncat first because they carry auth inline and are broadly
// available; corkscrew last (no inline auth, niche but purpose-built).
export const SSH_PROXY_HELPERS: readonly SshProxyHelper[] = [
	{
		command: "socat",
		supportsInlineAuth: true,
		buildProxyCommand: ({ host, port, username, password }) => {
			const auth = username ? `,proxyauth=${username}:${password}` : "";
			return `socat - PROXY:${host}:%h:%p,proxyport=${port}${auth}`;
		},
	},
	{
		command: "ncat",
		supportsInlineAuth: true,
		buildProxyCommand: ({ host, port, username, password }) => {
			const auth = username ? ` --proxy-auth ${username}:${password}` : "";
			return `ncat --proxy ${host}:${port} --proxy-type http${auth} %h %p`;
		},
	},
	{
		command: "corkscrew",
		supportsInlineAuth: false,
		buildProxyCommand: ({ host, port }) => `corkscrew ${host} ${port} %h %p`,
	},
];

/**
 * Picks the first PATH-available CONNECT helper, honoring the inline-auth
 * constraint. `isAvailable` is injected for testing; production passes the cached
 * PATH detector. Returns `null` when nothing suitable is installed.
 */
export function selectSshProxyHelper(
	needsAuth: boolean,
	isAvailable: (binary: string) => boolean = cachedIsBinaryAvailable,
): SshProxyHelper | null {
	for (const helper of SSH_PROXY_HELPERS) {
		if (needsAuth && !helper.supportsInlineAuth) continue;
		if (isAvailable(helper.command)) return helper;
	}
	return null;
}

/**
 * POSIX single-quote a value so the whole thing reaches ssh as one literal token.
 * git runs GIT_SSH_COMMAND through `sh -c`, so the ProxyCommand value must survive
 * that parse intact; single quotes prevent any shell expansion, and an embedded
 * single quote is escaped with the standard `'\''` idiom.
 */
function singleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Assembles the GIT_SSH_COMMAND value: a base ssh invocation plus an
 * `-o ProxyCommand=<helper>` option. When the caller already has a GIT_SSH_COMMAND
 * (e.g. a custom key/config), it is preserved and the ProxyCommand is appended, so
 * proxying is added without clobbering their setup.
 */
export function buildGitSshCommand(proxyCommandValue: string, existingCommand?: string): string {
	const base = existingCommand?.trim() ? existingCommand.trim() : "ssh";
	return `${base} -o ProxyCommand=${singleQuote(proxyCommandValue)}`;
}

function parseProxyTarget(proxyUrl: string): SshProxyTarget | null {
	try {
		const url = new URL(proxyUrl);
		return {
			host: url.hostname,
			// ssh CONNECT helpers need an explicit proxy port; default to the http port.
			port: url.port || "80",
			username: url.username ? decodeURIComponent(url.username) : "",
			password: url.password ? decodeURIComponent(url.password) : "",
		};
	} catch {
		return null;
	}
}

// PATH availability is stable for the process lifetime; cache it so the per-spawn
// git hot path doesn't re-scan PATH for each helper on every git invocation.
const availabilityCache = new Map<string, boolean>();

function cachedIsBinaryAvailable(binary: string): boolean {
	const cached = availabilityCache.get(binary);
	if (cached !== undefined) return cached;
	const available = isBinaryAvailableOnPath(binary);
	availabilityCache.set(binary, available);
	return available;
}

let warnedNoHelper = false;

/** Test-only: clears the PATH-availability cache and the one-time warning latch. */
export function resetGitSshProxyCacheForTests(): void {
	availabilityCache.clear();
	warnedNoHelper = false;
}

/**
 * Builds the GIT_SSH_COMMAND env record for a git subprocess so SSH remotes route
 * through Kanban's configured proxy. Returns `{}` (no-op) when the proxy is
 * disabled, the URL can't be parsed, or no CONNECT helper is installed — in the
 * last case it warns once so the operator can install one. `existingCommand` is
 * the caller's inherited GIT_SSH_COMMAND, preserved by appending. `isAvailable` is
 * injectable for testing.
 */
export function buildGitSshProxyEnv(
	existingCommand?: string,
	isAvailable: (binary: string) => boolean = cachedIsBinaryAvailable,
): Record<string, string> {
	const state = getRuntimeProxyState();
	if (!state.enabled || !state.proxyUrl) return {};

	const target = parseProxyTarget(state.proxyUrl);
	if (!target) return {};

	const helper = selectSshProxyHelper(target.username !== "", isAvailable);
	if (!helper) {
		if (!warnedNoHelper) {
			warnedNoHelper = true;
			log.warn(
				"SSH git remotes will not be proxied: no HTTP-CONNECT helper found on PATH (install socat, ncat, or corkscrew). HTTP(S) remotes are unaffected.",
				{ candidates: SSH_PROXY_HELPERS.map((entry) => entry.command).join(",") },
			);
		}
		return {};
	}

	return { GIT_SSH_COMMAND: buildGitSshCommand(helper.buildProxyCommand(target), existingCommand) };
}
