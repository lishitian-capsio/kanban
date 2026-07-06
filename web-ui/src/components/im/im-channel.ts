import type { RuntimeHomeChatThreadBindImChannelRequest } from "@/runtime/types";

/**
 * The platform-agnostic IM binding descriptor from the backend (T4). Derived from the
 * bind-request contract so web-ui never redefines the shape — `api-contract` imports
 * `imChannelTargetSchema` but does not re-export the type, so this projection is the
 * canonical web-ui alias.
 */
export type ImChannelTarget = RuntimeHomeChatThreadBindImChannelRequest["channel"];
export type ImPlatform = ImChannelTarget["platform"];

/** Chinese display labels. `Record<ImPlatform, …>` forces compile-time coverage of every platform. */
export const IM_PLATFORM_LABELS: Record<ImPlatform, string> = {
	lark: "飞书",
	dingtalk: "钉钉",
};

export interface ImPlatformOption {
	value: ImPlatform;
	label: string;
}

export const IM_PLATFORM_OPTIONS: ImPlatformOption[] = (
	Object.entries(IM_PLATFORM_LABELS) as [ImPlatform, string][]
).map(([value, label]) => ({ value, label }));

/**
 * Mirrors the backend `inferLarkReceiveIdType` (src/im/lark/lark-message-format.ts) as a
 * presentation label. Kept in web-ui deliberately — a ~5-line display mapping, not shared logic.
 */
export function inferLarkKindLabel(chatId: string): string {
	const id = chatId.trim();
	if (id.startsWith("oc_")) return "群聊";
	if (id.startsWith("ou_")) return "单聊";
	if (id.startsWith("on_")) return "union";
	if (id.includes("@")) return "邮箱";
	return "群聊";
}

export function describeImChannel(target: ImChannelTarget): { platformLabel: string; kindLabel: string } {
	const platformLabel = IM_PLATFORM_LABELS[target.platform] ?? target.platform;
	// DingTalk delivery is a webhook robot bound to one conversation — no chat-kind concept.
	const kindLabel = target.platform === "lark" ? inferLarkKindLabel(target.chatId) : "群";
	return { platformLabel, kindLabel };
}
