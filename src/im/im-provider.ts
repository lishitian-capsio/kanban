/**
 * The IM outbound provider contract. A concrete adapter (Lark, DingTalk, …) implements this
 * interface and registers itself by its {@link ImPlatform} id via {@link ./im-provider-registry}.
 * Adapters resolve their own outbound credential from the machine-local store — credentials are
 * never passed through this interface, mirroring how the host-keyed git credential injectors
 * self-resolve their secrets.
 */
import type { ImCard, ImChannelTarget, ImPlatform, ImSendResult, ImTextMessage } from "./types";

export interface ImProvider {
	/** The platform this adapter serves. The registry keys on this value. */
	readonly platform: ImPlatform;

	/** Deliver a plain-text message to the target channel. */
	sendMessage(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult>;

	/** Deliver a rich interactive card to the target channel. */
	sendCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult>;

	/**
	 * Best-effort resolve a human-readable name for a chat/conversation (e.g. a Lark group's title
	 * or a single chat's peer name), so the UI can show something readable instead of the opaque
	 * platform id. Returns `null` when the name is unknown or the platform has no name-lookup API.
	 *
	 * Optional: a platform whose delivery mechanism carries no name-lookup capability (e.g. a
	 * DingTalk custom-robot webhook) simply omits it, and callers fall back to the raw chat id.
	 * Implementations MUST NOT throw for the "unresolvable" case — resolve to `null` instead.
	 */
	resolveChatName?(target: ImChannelTarget): Promise<string | null>;
}
