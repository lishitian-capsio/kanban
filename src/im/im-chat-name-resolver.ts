/**
 * Best-effort resolution of a human-readable name for an IM chat (requirement ac99c) — so the
 * bindable "IM 会话 id 列表" and the bound-channel chip can show a readable group/conversation
 * name (e.g. Lark's `"Technology.Result"`) instead of the opaque platform id (`oc_4c1e…`).
 *
 * This is a thin adapter over the platform-keyed {@link ImProvider} registry: it asks the
 * registered adapter for the platform to {@link ImProvider.resolveChatName}. A platform whose
 * adapter has no name-lookup capability (or is not registered / has no credential yet) yields
 * `null`, and callers fall back to the raw chat id. It NEVER throws — a resolution failure is a
 * `null`, never an error that could break the record/add path that calls it.
 */
import { createLogger } from "../logging";
import { getImProvider } from "./im-provider-registry";
import type { ImPlatform } from "./types";

const log = createLogger("im.chat-name-resolver");

/**
 * Resolve a display name for `(platform, chatId)`, or `null` when it cannot be resolved (no
 * adapter, no name-lookup capability, unconfigured credential, or a lookup failure). The returned
 * name is trimmed and guaranteed non-empty; an empty/whitespace result maps to `null`.
 */
export async function resolveImChatDisplayName(platform: ImPlatform, chatId: string): Promise<string | null> {
	const provider = getImProvider(platform);
	if (!provider?.resolveChatName) {
		return null;
	}
	try {
		const name = await provider.resolveChatName({ platform, chatId });
		const trimmed = name?.trim();
		return trimmed && trimmed.length > 0 ? trimmed : null;
	} catch (error) {
		// Defensive: the interface asks adapters not to throw, but a bug there must not break the
		// record/add path — degrade to null so the caller falls back to the raw id.
		log.debug("failed to resolve IM chat display name", { platform, error });
		return null;
	}
}
