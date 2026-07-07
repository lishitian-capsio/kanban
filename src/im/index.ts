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
export {
	DingtalkStreamConnector,
	type DingtalkStreamConnectorDeps,
	registerDingtalkStreamConnector,
} from "./dingtalk/dingtalk-stream-connector";
export {
	buildDingtalkOpenRequest,
	decodeDingtalkBotMessage,
	DINGTALK_BOT_MESSAGE_TOPIC,
	DINGTALK_STREAM_OPEN_ENDPOINT,
	type DingtalkStreamCredential,
	type DingtalkStreamFrame,
	parseDingtalkStreamCredential,
	parseDingtalkStreamFrame,
} from "./dingtalk/dingtalk-stream-protocol";
export type {
	DingtalkStreamEndpoint,
	DingtalkStreamOpener,
	DingtalkStreamSocket,
	DingtalkStreamSocketFactory,
	DingtalkStreamSocketHandlers,
} from "./dingtalk/dingtalk-stream-transport";
export type { DingtalkApiResponse, DingtalkTransport } from "./dingtalk/dingtalk-transport";
export { DingtalkStreamCredentialFormatError, DingtalkStreamOpenError } from "./dingtalk/errors";
export { ImCredentialUnavailableError, ImError, ImSendFailedError, UnsupportedImPlatformError } from "./errors";
export type {
	ImConnectionState,
	ImConnectorContext,
	ImGatewayConnector,
	ImGatewayDeps,
	ImInboundEvent,
	ImInboundEventListener,
	ImInboundImage,
	ImInboundMessageEvent,
} from "./gateway";
export {
	DEFAULT_RECONNECT_DELAYS_MS,
	getImGatewayConnector,
	ImGateway,
	listRegisteredImGatewayConnectorPlatforms,
	registerImGatewayConnector,
	unregisterImGatewayConnector,
} from "./gateway";
export type { ImCredentialPlatformStatus, ImCredentialServiceDeps } from "./im-credential-service";
export { getImCredentialService, ImCredentialService } from "./im-credential-service";
export {
	clearPersistedImCredentials,
	getImCredentialsFilePath,
	readPersistedImCredentials,
	resolveImCredential,
	statImCredentialsMtimeMs,
	writePersistedImCredentials,
} from "./im-credential-store";
export { sendImCard, sendImText } from "./im-dispatch";
export type { ImProvider } from "./im-provider";
export {
	getImProvider,
	listRegisteredImPlatforms,
	registerImProvider,
	requireImProvider,
	unregisterImProvider,
} from "./im-provider-registry";
export type { BuiltImTaskMessage, ImTaskEventKind, ImTaskMessageContext } from "./im-task-event";
export { buildImTaskMessage, classifyImTaskEvent, isImTaskCardKind } from "./im-task-event";
export type { ImTaskEventNotifierDeps, ImTaskRoute } from "./im-task-notifier";
export { ImTaskEventNotifier } from "./im-task-notifier";
export { resolveTaskRouteFromBoard, resolveThreadImChannelFromThreads } from "./im-task-route-resolver";
export type {
	LarkBotCredential,
	LarkFetch,
	LarkImGatewayConnectorOptions,
	LarkImProviderOptions,
	LarkReceiveIdType,
} from "./lark";
export {
	LarkApiError,
	LarkCredentialFormatError,
	LarkImGatewayConnector,
	LarkImProvider,
	registerLarkImGatewayConnector,
	registerLarkImProvider,
} from "./lark";
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
