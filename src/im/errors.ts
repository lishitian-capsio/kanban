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
