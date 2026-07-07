/**
 * Orchestration seam for the machine-local IM **outbound credentials** management surface: the
 * single object the `im` tRPC router (and any future CLI) talks to when a user configures the
 * bot token / webhook for a platform in Settings.
 *
 * It sits on top of the raw {@link ./im-credential-store} (read/write/clear of the 0600
 * `~/.kanban/settings/im-credentials.json` file) and adds the two things a management surface
 * needs that the store does not model: a **secret-free per-platform status** (is a platform
 * configured, and which credential fields are present — booleans only, never the values), and a
 * **per-platform** set/clear (the store's `clear` removes the whole file; here clearing one
 * platform leaves the others intact).
 *
 * Mirrors {@link ../gitee-auth/gitee-auth-service} in spirit: a process-wide singleton, all
 * collaborators injectable for tests, and — critically — NO info log on the success path, because
 * the console sink routes `info` to stdout and would corrupt a `--json` CLI envelope.
 */

import {
	clearPersistedImCredentials,
	getImCredentialsFilePath,
	readPersistedImCredentials,
	writePersistedImCredentials,
} from "./im-credential-store";
import {
	IM_PLATFORMS,
	type ImOutboundCredential,
	type ImPlatform,
	imOutboundCredentialSchema,
	type PersistedImCredentials,
} from "./types";

/** Secret-free status for a single platform: presence flags only, never the credential values. */
export interface ImCredentialPlatformStatus {
	platform: ImPlatform;
	configured: boolean;
	hasBotToken: boolean;
	hasWebhookUrl: boolean;
	hasWebhookSecret: boolean;
}

export interface ImCredentialServiceDeps {
	resolvePath?: () => string;
}

function statusForPlatform(
	platform: ImPlatform,
	credential: ImOutboundCredential | undefined,
): ImCredentialPlatformStatus {
	return {
		platform,
		configured: Boolean(credential),
		hasBotToken: Boolean(credential?.botToken),
		hasWebhookUrl: Boolean(credential?.webhookUrl),
		hasWebhookSecret: Boolean(credential?.webhookSecret),
	};
}

/** Trim each field and drop empties, then validate (keeps the "at least one of token/webhook" rule). */
function normalizeCredential(input: ImOutboundCredential): ImOutboundCredential {
	const cleaned: ImOutboundCredential = {};
	const botToken = input.botToken?.trim();
	const webhookUrl = input.webhookUrl?.trim();
	const webhookSecret = input.webhookSecret?.trim();
	if (botToken) cleaned.botToken = botToken;
	if (webhookUrl) cleaned.webhookUrl = webhookUrl;
	if (webhookSecret) cleaned.webhookSecret = webhookSecret;
	return imOutboundCredentialSchema.parse(cleaned);
}

export class ImCredentialService {
	private readonly resolvePath: () => string;

	constructor(deps: ImCredentialServiceDeps = {}) {
		this.resolvePath = deps.resolvePath ?? getImCredentialsFilePath;
	}

	/** Secret-free status for every supported platform (so the UI can render all cards). */
	async getStatus(): Promise<ImCredentialPlatformStatus[]> {
		const record = await readPersistedImCredentials(this.resolvePath());
		return IM_PLATFORMS.map((platform) => statusForPlatform(platform, record?.[platform]));
	}

	/**
	 * Store (or replace) a single platform's outbound credential, leaving other platforms intact.
	 * The credential is normalized + validated first (throws on an all-empty credential). Returns
	 * the refreshed secret-free status.
	 */
	async setCredential(platform: ImPlatform, credential: ImOutboundCredential): Promise<ImCredentialPlatformStatus[]> {
		const normalized = normalizeCredential(credential);
		const path = this.resolvePath();
		const record = (await readPersistedImCredentials(path)) ?? {};
		const next: PersistedImCredentials = { ...record, [platform]: normalized };
		await writePersistedImCredentials(path, next);
		return IM_PLATFORMS.map((p) => statusForPlatform(p, next[p]));
	}

	/**
	 * Remove a single platform's credential. When no platforms remain the whole file is removed;
	 * otherwise the remaining platforms are re-persisted. Idempotent. Returns the refreshed status.
	 */
	async clearCredential(platform: ImPlatform): Promise<ImCredentialPlatformStatus[]> {
		const path = this.resolvePath();
		const record = await readPersistedImCredentials(path);
		if (!record || !record[platform]) {
			return IM_PLATFORMS.map((p) => statusForPlatform(p, record?.[p]));
		}
		const next: PersistedImCredentials = { ...record };
		delete next[platform];
		if (Object.keys(next).length === 0) {
			await clearPersistedImCredentials(path);
		} else {
			await writePersistedImCredentials(path, next);
		}
		return IM_PLATFORMS.map((p) => statusForPlatform(p, next[p]));
	}
}

let singleton: ImCredentialService | null = null;

/** The process-wide service (machine-global secret; no workspace scope). */
export function getImCredentialService(): ImCredentialService {
	if (!singleton) {
		singleton = new ImCredentialService();
	}
	return singleton;
}
