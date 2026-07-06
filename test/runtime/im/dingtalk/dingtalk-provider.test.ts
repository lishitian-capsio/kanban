import { afterEach, describe, expect, it } from "vitest";

import type { ImChannelTarget, ImOutboundCredential } from "../../../../src/im";
import { ImCredentialUnavailableError, ImSendFailedError } from "../../../../src/im/errors";
import { getImProvider, unregisterImProvider } from "../../../../src/im/im-provider-registry";
import { DingtalkImProvider, registerDingtalkImProvider } from "../../../../src/im/dingtalk/dingtalk-provider";
import type { DingtalkApiResponse, DingtalkTransport } from "../../../../src/im/dingtalk/dingtalk-transport";

/** In-memory transport that records posts and returns a canned response (or throws). */
class FakeTransport implements DingtalkTransport {
	readonly calls: { url: string; body: unknown }[] = [];
	response: DingtalkApiResponse | Error = { errcode: 0, errmsg: "ok" };

	async post(url: string, body: unknown): Promise<DingtalkApiResponse> {
		this.calls.push({ url, body });
		if (this.response instanceof Error) {
			throw this.response;
		}
		return this.response;
	}
}

const target: ImChannelTarget = { platform: "dingtalk", chatId: "chat-token" };

function makeProvider(
	credential: ImOutboundCredential | null,
	transport: FakeTransport,
	now = () => 1_700_000_000_000,
): DingtalkImProvider {
	return new DingtalkImProvider({
		resolveCredential: async () => credential,
		transport,
		now,
	});
}

describe("DingtalkImProvider.sendMessage", () => {
	it("posts a text payload to the resolved webhook and returns the target descriptor", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		const result = await provider.sendMessage(target, { text: "ping" });

		expect(transport.calls).toHaveLength(1);
		expect(transport.calls[0].body).toEqual({ msgtype: "text", text: { content: "ping" } });
		expect(new URL(transport.calls[0].url).searchParams.get("access_token")).toBe("chat-token");
		expect(result).toEqual({ platform: "dingtalk", chatId: "chat-token" });
	});

	it("signs the webhook URL when the credential carries a webhookSecret", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider(
			{ webhookUrl: "https://oapi.dingtalk.com/robot/send", webhookSecret: "sec" },
			transport,
		);

		await provider.sendMessage(target, { text: "ping" });

		const url = transport.calls[0].url;
		expect(url).toContain("timestamp=1700000000000");
		expect(url).toContain("sign=");
	});

	it("does not sign when no webhookSecret is configured", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		await provider.sendMessage(target, { text: "ping" });

		expect(transport.calls[0].url).not.toContain("sign=");
	});

	it("throws ImCredentialUnavailableError and does not call the transport when unconfigured", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider(null, transport);

		await expect(provider.sendMessage(target, { text: "ping" })).rejects.toBeInstanceOf(
			ImCredentialUnavailableError,
		);
		expect(transport.calls).toHaveLength(0);
	});

	it("propagates a transport/network error (throwing leaf)", async () => {
		const transport = new FakeTransport();
		transport.response = new Error("network down");
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		await expect(provider.sendMessage(target, { text: "ping" })).rejects.toThrow("network down");
		expect(transport.calls).toHaveLength(1);
	});

	it("throws ImSendFailedError on a non-zero DingTalk errcode", async () => {
		const transport = new FakeTransport();
		transport.response = { errcode: 310000, errmsg: "keywords not in content" };
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		await expect(provider.sendMessage(target, { text: "ping" })).rejects.toBeInstanceOf(ImSendFailedError);
	});
});

describe("DingtalkImProvider.sendCard", () => {
	it("posts an actionCard payload for a card with buttons", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		await provider.sendCard(target, {
			title: "Review",
			text: "PR ready",
			buttons: [{ text: "Open", url: "https://example.com/pr" }],
		});

		expect(transport.calls[0].body).toEqual({
			msgtype: "actionCard",
			actionCard: {
				title: "Review",
				text: "PR ready",
				singleTitle: "Open",
				singleURL: "https://example.com/pr",
			},
		});
	});

	it("posts a markdown payload for a card with no buttons", async () => {
		const transport = new FakeTransport();
		const provider = makeProvider({ webhookUrl: "https://oapi.dingtalk.com/robot/send" }, transport);

		await provider.sendCard(target, { title: "Note", text: "body" });

		expect(transport.calls[0].body).toEqual({
			msgtype: "markdown",
			markdown: { title: "Note", text: "body" },
		});
	});
});

describe("registerDingtalkImProvider", () => {
	afterEach(() => unregisterImProvider("dingtalk"));

	it("registers a DingTalk adapter under the dingtalk platform id", () => {
		registerDingtalkImProvider();
		const provider = getImProvider("dingtalk");
		expect(provider).toBeInstanceOf(DingtalkImProvider);
		expect(provider?.platform).toBe("dingtalk");
	});
});
