import { afterEach, describe, expect, it } from "vitest";

import { resolveImChatDisplayName } from "../../../src/im/im-chat-name-resolver";
import type { ImProvider } from "../../../src/im/im-provider";
import { registerImProvider, unregisterImProvider } from "../../../src/im/im-provider-registry";
import type { ImCard, ImChannelTarget, ImSendResult, ImTextMessage } from "../../../src/im/types";

/** Minimal fake provider with a configurable name-resolution behavior. */
function fakeProvider(resolveChatName?: ImProvider["resolveChatName"]): ImProvider {
	return {
		platform: "lark",
		sendMessage: (_t: ImChannelTarget, _m: ImTextMessage): Promise<ImSendResult> => {
			throw new Error("not used");
		},
		sendCard: (_t: ImChannelTarget, _c: ImCard): Promise<ImSendResult> => {
			throw new Error("not used");
		},
		...(resolveChatName ? { resolveChatName } : {}),
	};
}

describe("resolveImChatDisplayName", () => {
	afterEach(() => {
		unregisterImProvider("lark");
	});

	it("returns null when no adapter is registered for the platform", async () => {
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBeNull();
	});

	it("returns null when the adapter has no resolveChatName capability", async () => {
		registerImProvider(fakeProvider());
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBeNull();
	});

	it("returns the trimmed name the adapter resolves", async () => {
		registerImProvider(fakeProvider(async () => "  Technology.Result  "));
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBe("Technology.Result");
	});

	it("maps an empty/whitespace resolved name to null", async () => {
		registerImProvider(fakeProvider(async () => "   "));
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBeNull();
	});

	it("maps a null resolution to null", async () => {
		registerImProvider(fakeProvider(async () => null));
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBeNull();
	});

	it("degrades a throwing adapter to null (never propagates)", async () => {
		registerImProvider(
			fakeProvider(async () => {
				throw new Error("boom");
			}),
		);
		expect(await resolveImChatDisplayName("lark", "oc_1")).toBeNull();
	});
});
