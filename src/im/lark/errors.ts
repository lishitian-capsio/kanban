/** Lark-adapter-specific errors. All extend the shared {@link ImError} base (see `../errors`). */
import { ImError } from "../errors";

/**
 * The stored Lark {@link ImOutboundCredential.botToken} was not the expected
 * `"<app_id>:<app_secret>"` shape (see {@link ./lark-message-format#parseLarkBotCredential}).
 */
export class LarkCredentialFormatError extends ImError {
	constructor() {
		super('lark botToken must be formatted as "<app_id>:<app_secret>"');
	}
}

/**
 * A Lark OpenAPI call failed — either a non-2xx HTTP status or a non-zero business `code` in the
 * JSON body. Carries the numeric `code` (Lark's business error code, or the HTTP status when the
 * failure was at the transport level) so callers can branch. The message never includes request
 * content or the token, only the API's own error text.
 */
export class LarkApiError extends ImError {
	constructor(
		message: string,
		readonly code: number,
	) {
		super(message);
	}
}
