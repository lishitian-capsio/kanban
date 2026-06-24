/**
 * Pure assembly of the `kanban remote status` result object (design doc §5.1, phase P4).
 *
 * `remote status` is the single "is my remote access working, where, and how do I get in?"
 * view. This module is the I/O-free core: it takes already-resolved facts (the bind target,
 * enumerated NICs, the Host/CORS gate authorities, the persisted passcode state, a health
 * probe, and the service status) and shapes them into the machine `data` payload. The disk
 * reads, the network probe, and the service-manager query live in `remote.ts`.
 *
 * Invariant carried from the rest of the remote subsystem: the passcode VALUE never appears
 * in this output — only whether one is set. The value stays on the human channel
 * (`remote passcode show`). The caller passes the value solely so `set` can be computed.
 */

/** Where a `remote status` reader can retrieve the passcode value (human channel only). */
export const REMOTE_PASSCODE_VIEW_COMMAND = "kanban remote passcode show";

/** Health probe of the targeted runtime. `latencyMs` is `null` when unreachable. */
export interface RemoteHealth {
	reachable: boolean;
	checkedUrl: string;
	latencyMs: number | null;
}

/** Installed-service summary embedded in `remote status` (mirrors `service status`). */
export interface RemoteServiceInfo {
	installed: boolean;
	running: boolean;
	platform: string;
	name: string;
}

/**
 * The persisted-passcode source the CLI can observe from disk. `explicit`/`generated` are
 * launch-time sources visible only in the boot banner of the running server process, so a
 * separate `remote status` invocation reports `persisted` (a value is on disk) or `none`.
 */
export type RemotePasscodeSource = "persisted" | "explicit" | "generated" | "none";

export interface RemoteStatusBuildInput {
	/** The resolved bind target (from `--host`/`--port`/env, else runtime defaults). */
	bind: { host: string; port: number; https: boolean };
	/** Whether the bind host is a loopback alias (127.0.0.1/::1/localhost). */
	isLoopbackBind: boolean;
	/** Whether the bind host is a wildcard ("any address") target (0.0.0.0/::). */
	isWildcardBind: boolean;
	/** Concrete NIC addresses, used to enumerate access URLs on a wildcard bind. */
	localNetworkHosts: readonly string[];
	/** `Host` authorities (host:port) the runtime's Host/CORS gate accepts — for self-diagnosis. */
	allowedHostAuthorities: readonly string[];
	/** Persisted passcode state. `value` is used only to compute `set`; never emitted. */
	passcode: { value: string | null; disabled: boolean };
	health: RemoteHealth;
	/** Installed-service summary, or `null` when the platform is unsupported / probe failed. */
	service: RemoteServiceInfo | null;
}

export interface RemoteStatusData {
	bind: { host: string; port: number; https: boolean };
	accessUrls: string[];
	remoteMode: boolean;
	passcode: {
		required: boolean;
		set: boolean;
		source: RemotePasscodeSource;
		viewCommand: string;
	};
	health: RemoteHealth;
	allowedHosts: string[];
	service: RemoteServiceInfo | null;
}

/**
 * Whether a host is a link-local address (IPv6 `fe80::/10` or IPv4 `169.254.0.0/16`). These
 * are excluded from the *access URL* list because they require a scope/zone and are not
 * shareable — but they remain in `allowedHosts` (which mirrors the gate verbatim).
 */
function isLinkLocalHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return /^fe[89ab][0-9a-f]:/.test(normalized) || normalized.startsWith("169.254.");
}

/**
 * Build the ordered, de-duplicated list of access URLs (design doc §5.1). Loopback is always
 * included so local access keeps working; a wildcard bind enumerates the real NIC IPs (the
 * literal "any address" is never something a browser connects to, and link-local addresses are
 * dropped as un-shareable), while a concrete remote bind lists that host verbatim. Remote/NIC
 * entries come first, loopback last (the operator usually wants the shareable URL on top).
 */
function buildAccessUrls(input: RemoteStatusBuildInput): string[] {
	const scheme = input.bind.https ? "https" : "http";
	const urls: string[] = [];
	const seen = new Set<string>();
	const push = (host: string): void => {
		const trimmed = host.trim();
		if (!trimmed) {
			return;
		}
		const authority = trimmed.includes(":") ? `[${trimmed}]` : trimmed;
		const url = `${scheme}://${authority}:${input.bind.port}`;
		if (!seen.has(url)) {
			seen.add(url);
			urls.push(url);
		}
	};

	if (!input.isLoopbackBind) {
		if (input.isWildcardBind) {
			for (const ip of input.localNetworkHosts) {
				if (!isLinkLocalHost(ip)) {
					push(ip);
				}
			}
		} else {
			// A concrete remote bind is the host the operator explicitly chose — keep it as-is.
			push(input.bind.host);
		}
	}
	push("127.0.0.1");
	return urls;
}

/**
 * Assemble the `remote status` machine `data` payload from resolved facts. Pure: no I/O, no
 * clock, no global reads. The passcode value is consumed only to derive `set` and is never
 * placed in the output.
 */
export function buildRemoteStatusData(input: RemoteStatusBuildInput): RemoteStatusData {
	const remoteMode = !input.isLoopbackBind;
	const disabled = input.passcode.disabled;
	const hasValue = input.passcode.value !== null && input.passcode.value.trim().length > 0;

	return {
		bind: { ...input.bind },
		accessUrls: buildAccessUrls(input),
		remoteMode,
		passcode: {
			// A non-loopback bind requires a passcode unless the operator persisted a disable.
			required: remoteMode && !disabled,
			set: hasValue && !disabled,
			source: hasValue && !disabled ? "persisted" : "none",
			viewCommand: REMOTE_PASSCODE_VIEW_COMMAND,
		},
		health: { ...input.health },
		allowedHosts: [...input.allowedHostAuthorities].sort(),
		service: input.service ? { ...input.service } : null,
	};
}
