/**
 * IM (instant-messaging) outbound abstraction: a platform-agnostic, pluggable capability for
 * sending messages/cards to bound IM channels (requirement ac99c, "会话可绑定 IM 渠道").
 *
 * This module provides only the interface + platform-keyed adapter registry + types + the
 * machine-local (0600) outbound-credential store. It deliberately implements NO concrete
 * platform — a Lark/DingTalk adapter is a later, separate registration (mirrors how DB engines
 * and host-keyed git credential injectors plug in).
 */
export { ImError, UnsupportedImPlatformError } from "./errors";
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
	imOutboundCredentialSchema,
	imPlatformSchema,
	persistedImCredentialsSchema,
} from "./types";
