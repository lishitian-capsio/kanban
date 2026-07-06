import { afterEach, describe, expect, it } from "vitest";
import type { ImCard, ImChannelTarget, ImPlatform, ImProvider, ImSendResult, ImTextMessage } from "../../../src/im";
import { UnsupportedImPlatformError } from "../../../src/im/errors";
import {
	getImProvider,
	listRegisteredImPlatforms,
	registerImProvider,
	requireImProvider,
	unregisterImProvider,
} from "../../../src/im/im-provider-registry";

/** A minimal in-memory adapter used to prove the interface shape + registry behavior. */
function makeFakeProvider(platform: ImPlatform): ImProvider & { readonly sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		platform,
		sent,
		async sendMessage(target: ImChannelTarget, message: ImTextMessage): Promise<ImSendResult> {
			sent.push({ kind: "message", target, message });
			return { platform, chatId: target.chatId, messageId: "m-1" };
		},
		async sendCard(target: ImChannelTarget, card: ImCard): Promise<ImSendResult> {
			sent.push({ kind: "card", target, card });
			return { platform, chatId: target.chatId, messageId: "c-1" };
		},
	};
}

describe("im-provider-registry", () => {
	afterEach(() => {
		unregisterImProvider("lark");
		unregisterImProvider("dingtalk");
	});

	it("registers an adapter keyed by its own platform id and returns it", () => {
		const lark = makeFakeProvider("lark");
		registerImProvider(lark);
		expect(getImProvider("lark")).toBe(lark);
	});

	it("getImProvider returns null when no adapter is registered for the platform", () => {
		expect(getImProvider("dingtalk")).toBeNull();
	});

	it("requireImProvider returns the adapter when registered", () => {
		const dingtalk = makeFakeProvider("dingtalk");
		registerImProvider(dingtalk);
		expect(requireImProvider("dingtalk")).toBe(dingtalk);
	});

	it("requireImProvider throws UnsupportedImPlatformError when none is registered", () => {
		expect(() => requireImProvider("lark")).toThrow(UnsupportedImPlatformError);
	});

	it("re-registering the same platform replaces the previous adapter (last wins)", () => {
		const first = makeFakeProvider("lark");
		const second = makeFakeProvider("lark");
		registerImProvider(first);
		registerImProvider(second);
		expect(getImProvider("lark")).toBe(second);
	});

	it("unregisterImProvider removes the adapter", () => {
		registerImProvider(makeFakeProvider("lark"));
		unregisterImProvider("lark");
		expect(getImProvider("lark")).toBeNull();
	});

	it("listRegisteredImPlatforms reflects the currently registered platforms", () => {
		expect(listRegisteredImPlatforms()).toEqual([]);
		registerImProvider(makeFakeProvider("lark"));
		registerImProvider(makeFakeProvider("dingtalk"));
		expect(listRegisteredImPlatforms().sort()).toEqual(["dingtalk", "lark"]);
	});

	it("an adapter's sendMessage / sendCard conform to the ImProvider contract", async () => {
		const lark = makeFakeProvider("lark");
		registerImProvider(lark);
		const target: ImChannelTarget = { platform: "lark", chatId: "oc_abc" };

		const msgResult = await requireImProvider("lark").sendMessage(target, { text: "hello" });
		expect(msgResult).toEqual({ platform: "lark", chatId: "oc_abc", messageId: "m-1" });

		const cardResult = await requireImProvider("lark").sendCard(target, {
			title: "Build",
			text: "done",
			buttons: [{ text: "Open", url: "https://example.com" }],
		});
		expect(cardResult).toEqual({ platform: "lark", chatId: "oc_abc", messageId: "c-1" });
		expect(lark.sent).toHaveLength(2);
	});
});
