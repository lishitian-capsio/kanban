/**
 * Lark outbound IM adapter: sends messages/cards to a Lark group or single chat as the bot/app
 * (the `im:message` send scope), authenticated with a `tenant_access_token` minted from an
 * `app_id`/`app_secret` stored in the machine-local (0600) IM credential store.
 */
export { LarkApiError, LarkCredentialFormatError } from "./errors";
export {
	buildLarkInteractiveCardContent,
	buildLarkTextMessageContent,
	inferLarkReceiveIdType,
	parseLarkBotCredential,
} from "./lark-message-format";
export type { LarkBotCredential, LarkReceiveIdType } from "./lark-message-format";
export { LarkImProvider, registerLarkImProvider } from "./lark-provider";
export type { LarkFetch, LarkImProviderOptions } from "./lark-provider";
