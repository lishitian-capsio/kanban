/** DingTalk-adapter-specific errors. All extend the shared {@link ImError} base (see `../errors`). */
import { ImError } from "../errors";

/**
 * The stored DingTalk {@link ImOutboundCredential.botToken} was not the expected
 * `"<appKey>:<appSecret>"` shape that the Stream-mode inbound connector needs (see
 * {@link ./dingtalk-stream-protocol#parseDingtalkStreamCredential}). Stream mode authenticates
 * with an **enterprise-bot** app credential, unlike the outbound custom-robot webhook which stores
 * a bare `access_token` in the same field — so a webhook-only credential cannot open a Stream
 * connection.
 */
export class DingtalkStreamCredentialFormatError extends ImError {
	constructor() {
		super('dingtalk botToken must be formatted as "<appKey>:<appSecret>" for Stream-mode inbound');
	}
}

/**
 * Opening the DingTalk Stream connection endpoint failed — a non-2xx HTTP status, a non-object
 * response, or a response missing the `endpoint` / `ticket` the WebSocket handshake needs. Carries
 * a short reason; never includes the app secret.
 */
export class DingtalkStreamOpenError extends ImError {
	constructor(message: string) {
		super(`dingtalk stream open failed: ${message}`);
	}
}
