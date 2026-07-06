/**
 * Runtime-safe outbound dispatch — the entry point the runtime calls to deliver an IM message.
 *
 * This is where the "发送失败只记日志不抛,不拖垮 runtime" guarantee lives: it resolves the adapter
 * for the target platform from the registry and invokes it inside a try/catch, so ANY failure
 * (no adapter registered, missing credential, network error, non-zero API code) is logged and
 * degraded to `null` rather than propagating. Concrete adapters (e.g. the Lark provider) stay
 * honest and throw on failure — this seam is what makes a failed IM send never crash the runtime,
 * mirroring the throwing-leaf + catching-egress idiom used by the host-keyed git credential
 * injectors. Message/card CONTENT is never logged, only the platform and the error.
 */
import { createLogger } from "../logging";
import { getImProvider } from "./im-provider-registry";
import type { ImCard, ImChannelTarget, ImSendResult, ImTextMessage } from "./types";

const log = createLogger("im.dispatch");

/**
 * Deliver a plain-text message to a bound IM channel. Returns the send result, or `null` when no
 * adapter is registered for the platform or the send failed (the failure is logged, never thrown).
 */
export async function sendImText(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult | null> {
	const provider = getImProvider(target.platform);
	if (!provider) {
		log.warn("no IM provider registered; dropping outbound text", { platform: target.platform });
		return null;
	}
	try {
		return await provider.sendMessage(target, message);
	} catch (error) {
		log.warn("IM text send failed; dropping", { platform: target.platform, error });
		return null;
	}
}

/**
 * Deliver a rich interactive card to a bound IM channel. Returns the send result, or `null` when
 * no adapter is registered for the platform or the send failed (logged, never thrown).
 */
export async function sendImCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult | null> {
	const provider = getImProvider(target.platform);
	if (!provider) {
		log.warn("no IM provider registered; dropping outbound card", { platform: target.platform });
		return null;
	}
	try {
		return await provider.sendCard(target, card);
	} catch (error) {
		log.warn("IM card send failed; dropping", { platform: target.platform, error });
		return null;
	}
}
