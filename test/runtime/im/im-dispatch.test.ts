import { afterEach, describe, expect, it } from "vitest";

import { sendImCard, sendImText } from "../../../src/im/im-dispatch";
import type { ImProvider } from "../../../src/im/im-provider";
import { registerImProvider, unregisterImProvider } from "../../../src/im/im-provider-registry";
import type { ImChannelTarget } from "../../../src/im/types";

const target: ImChannelTarget = { platform: "lark", chatId: "oc_g" };

function registerProvider(impl: Partial<ImProvider>): void {
	registerImProvider({
		platform: "lark",
		sendMessage: async () => ({ platform: "lark", chatId: target.chatId }),
		sendCard: async () => ({ platform: "lark", chatId: target.chatId }),
		...impl,
	} as ImProvider);
}

describe("im-dispatch (runtime-safe outbound seam)", () => {
	afterEach(() => unregisterImProvider("lark"));

	it("returns the send result on success", async () => {
		registerProvider({ sendMessage: async () => ({ platform: "lark", chatId: "oc_g", messageId: "m1" }) });
		expect(await sendImText(target, { text: "hi" })).toEqual({ platform: "lark", chatId: "oc_g", messageId: "m1" });
	});

	it("returns null (logs, does not throw) when no adapter is registered", async () => {
		await expect(sendImText(target, { text: "hi" })).resolves.toBeNull();
		await expect(sendImCard(target, { text: "hi" })).resolves.toBeNull();
	});

	it("swallows a throwing provider so a send failure never drags down the runtime", async () => {
		registerProvider({
			sendMessage: async () => {
				throw new Error("network down");
			},
			sendCard: async () => {
				throw new Error("network down");
			},
		});
		await expect(sendImText(target, { text: "hi" })).resolves.toBeNull();
		await expect(sendImCard(target, { title: "t", text: "b" })).resolves.toBeNull();
	});
});
