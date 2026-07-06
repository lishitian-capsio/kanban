/** Errors thrown by the IM outbound abstraction, so callers can branch on `instanceof ImError`. */

/** Base class for every error this layer throws. */
export class ImError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** No {@link ImProvider} adapter is registered for the requested platform. */
export class UnsupportedImPlatformError extends ImError {
	constructor(readonly platform: string) {
		super(`no IM provider registered for platform "${platform}"`);
	}
}

/**
 * No usable outbound credential is configured for the platform in the machine-local store — the
 * adapter cannot authenticate its send. A configured-but-wrong-shape credential surfaces as a
 * platform-specific error instead (e.g. a Lark `botToken` that isn't `app_id:app_secret`).
 */
export class ImCredentialUnavailableError extends ImError {
	constructor(readonly platform: string) {
		super(`no outbound credential configured for IM platform "${platform}"`);
	}
}

/**
 * The platform's send API accepted the request but reported a failure (a non-success status code
 * in its response body, e.g. a non-zero DingTalk `errcode`). Never carries message content.
 */
export class ImSendFailedError extends ImError {
	constructor(
		readonly platform: string,
		readonly code: number,
		readonly detail?: string,
	) {
		super(`IM platform "${platform}" rejected the send (code ${code}${detail ? `: ${detail}` : ""})`);
	}
}
