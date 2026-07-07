/**
 * Shared Lark OpenAPI endpoint constants + URL builders, so the outbound provider, tenant-token
 * minter and inbound connector agree on one base URL and one message-resource path shape.
 */

/** Default Lark OpenAPI base (feishu.cn). Override for the lark.com global tenant where needed. */
export const DEFAULT_LARK_BASE_URL = "https://open.feishu.cn";

/**
 * Build the message-resource download URL for a received message's attachment (image / file).
 * `GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}?type={type}` returns the raw
 * bytes when authenticated with a `tenant_access_token`.
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get
 */
export function buildLarkMessageResourceUrl(
	baseUrl: string,
	messageId: string,
	fileKey: string,
	type: "image" | "file",
): string {
	const root = baseUrl.replace(/\/+$/, "");
	return `${root}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
}
