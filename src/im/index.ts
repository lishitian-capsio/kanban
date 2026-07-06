/**
 * IM (instant-messaging) outbound abstraction: a platform-agnostic, pluggable capability for
 * sending messages/cards to bound IM channels (requirement ac99c, "会话可绑定 IM 渠道").
 *
 * This module provides the interface + platform-keyed adapter registry + types + the machine-local
 * (0600) outbound-credential store, plus the concrete adapters that plug into it (Lark, DingTalk).
 * Each adapter self-registers by its {@link ImPlatform} id (mirrors how DB engines and host-keyed
 * git credential injectors plug in).
 */
export {
	buildDingtalkCardPayload,
	buildDingtalkTextPayload,
	DINGTALK_DEFAULT_CARD_TITLE,
	DINGTALK_DEFAULT_ROBOT_ENDPOINT,
	resolveDingtalkWebhookUrl,
	signDingtalkWebhookUrl,
} from "./dingtalk/dingtalk-message";
export { DingtalkImProvider, registerDingtalkImProvider } from "./dingtalk/dingtalk-provider";
export type { DingtalkApiResponse, DingtalkTransport } from "./dingtalk/dingtalk-transport";
export { ImCredentialUnavailableError, ImError, ImSendFailedError, UnsupportedImPlatformError } from "./errors";
export { sendImCard, sendImText } from "./im-dispatch";
export {
	LarkApiError,
	LarkCredentialFormatError,
	LarkImProvider,
	registerLarkImProvider,
} from "./lark";
export type { LarkBotCredential, LarkFetch, LarkImProviderOptions, LarkReceiveIdType } from "./lark";
export {
	clearPersistedImCredentials,
	getImCredentialsFilePath,
	readPersistedImCredentials,
	resolveImCredential,
	statImCredentialsMtimeMs,
	writePersistedImCredentials,
} from "./im-credential-store";
export type { ImProvider } from "./im-provider";
export {
	getImProvider,
	listRegisteredImPlatforms,
	registerImProvider,
	requireImProvider,
	unregisterImProvider,
} from "./im-provider-registry";
export type {
	ImCard,
	ImCardButton,
	ImChannelTarget,
	ImOutboundCredential,
	ImPlatform,
	ImSendResult,
	ImTextMessage,
	PersistedImCredentials,
} from "./types";
export {
	IM_PLATFORMS,
	imChannelTargetSchema,
	imOutboundCredentialSchema,
	imPlatformSchema,
	persistedImCredentialsSchema,
} from "./types";
