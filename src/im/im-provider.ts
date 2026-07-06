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
}
