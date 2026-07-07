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

/**
 * Build the group-chat info URL. `GET /open-apis/im/v1/chats/{chat_id}` returns the group's
 * `data.name` (e.g. `"Technology.Result"`) when authenticated with a `tenant_access_token`.
 *
 * @see https://open.feishu.cn/document/server-docs/group/chat/get
 */
export function buildLarkChatInfoUrl(baseUrl: string, chatId: string): string {
	const root = baseUrl.replace(/\/+$/, "");
	return `${root}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`;
}

/**
 * Build the contact user-info URL used to resolve a single chat's peer name. `GET
 * /open-apis/contact/v3/users/{user_id}?user_id_type={type}` returns `data.user.name`.
 *
 * @see https://open.feishu.cn/document/server-docs/contact-v3/user/get
 */
export function buildLarkUserInfoUrl(baseUrl: string, userId: string, userIdType: string): string {
	const root = baseUrl.replace(/\/+$/, "");
	return `${root}/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=${encodeURIComponent(userIdType)}`;
}
