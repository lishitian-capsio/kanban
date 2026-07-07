import { describe, expect, it } from "vitest";

import type { ImConnectorContext } from "../../../src/im/gateway/im-gateway-connector";
import type { ImInboundEvent } from "../../../src/im/gateway/inbound-event";
import type { LarkFetch } from "../../../src/im/lark/lark-http";
import { LarkImGatewayConnector } from "../../../src/im/lark/lark-inbound-connector";
import type { LarkInboundTransport, LarkInboundTransportHandlers } from "../../../src/im/lark/lark-inbound-transport";

/** Flush pending microtasks + one macrotask so the connector's async emit/download settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeFakeTransport() {
	let handlers: LarkInboundTransportHandlers | null = null;
	let stopped = false;
	let startCount = 0;
	const transport: LarkInboundTransport = {
		async start(h) {
			handlers = h;
			startCount += 1;
		},
		async stop() {
			stopped = true;
		},
	};
	return {
		transport,
		deliver: (data: unknown) => handlers?.onMessage(data),
		drop: (error?: unknown) => handlers?.onDisconnect(error),
		get stopped() {
			return stopped;
		},
		get startCount() {
			return startCount;
		},
	};
}

/** A fake fetch serving the tenant-token mint + image-resource download, recording every call. */
function makeFakeFetch(imageBytes = new Uint8Array([1, 2, 3])) {
	const calls: string[] = [];
	const fetchImpl: LarkFetch = async (url) => {
		calls.push(url);
		if (url.includes("/tenant_access_token/")) {
			return new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/resources/")) {
			return new Response(imageBytes, { status: 200, headers: { "content-type": "image/png" } });
		}
		throw new Error(`unexpected fetch to ${url}`);
	};
	return { fetchImpl, calls };
}

function makeContext() {
	const emitted: ImInboundEvent[] = [];
	const signals: unknown[] = [];
	const context: ImConnectorContext = {
		emit: (event) => emitted.push(event),
		signalDisconnected: (error) => signals.push(error),
	};
	return { context, emitted, signals };
}

function textEvent(eventId: string, text: string, chatId = "oc_group", openId = "ou_sender"): unknown {
	return {
		event_id: eventId,
		event_type: "im.message.receive_v1",
		sender: { sender_id: { open_id: openId }, sender_type: "user" },
		message: { message_id: "om_1", chat_id: chatId, message_type: "text", content: JSON.stringify({ text }) },
	};
}

function imageEvent(eventId: string, imageKey: string): unknown {
	return {
		event_id: eventId,
		sender: { sender_id: { open_id: "ou_s" } },
		message: {
			message_id: "om_img",
			chat_id: "oc_c",
			message_type: "image",
			content: JSON.stringify({ image_key: imageKey }),
		},
	};
}

async function connect(overrides: Partial<ConstructorParameters<typeof LarkImGatewayConnector>[0]> = {}) {
	const fake = makeFakeTransport();
	const { fetchImpl, calls } = makeFakeFetch();
	const { context, emitted, signals } = makeContext();
	const connector = new LarkImGatewayConnector({
		transport: fake.transport,
		fetchImpl,
		resolveCredential: async () => ({ botToken: "cli_app:secret" }),
		...overrides,
	});
	await connector.connect(context);
	return { connector, fake, fetchCalls: calls, context, emitted, signals };
}

describe("LarkImGatewayConnector inbound", () => {
	it("normalizes a text message into a gateway message event", async () => {
		const { fake, emitted } = await connect();
		fake.deliver(textEvent("e1", "hello there"));
		await flush();
		expect(emitted).toEqual([
			{ kind: "message", platform: "lark", channelKey: "oc_group", text: "hello there", senderId: "ou_sender" },
		]);
	});

	it("dedups by event_id (at-least-once redelivery collapses to one emit)", async () => {
		const { fake, emitted } = await connect();
		fake.deliver(textEvent("dup", "once"));
		fake.deliver(textEvent("dup", "once"));
		await flush();
		expect(emitted).toHaveLength(1);
	});

	it("downloads message images and attaches them base64-encoded", async () => {
		const { fake, emitted, fetchCalls } = await connect();
		fake.deliver(imageEvent("img1", "img_v2_abc"));
		await flush();
		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		expect(event.kind).toBe("message");
		if (event.kind !== "message") throw new Error("unreachable");
		expect(event.images).toEqual([{ mimeType: "image/png", dataBase64: Buffer.from([1, 2, 3]).toString("base64") }]);
		// One token mint + one resource download.
		expect(fetchCalls.filter((u) => u.includes("/tenant_access_token/"))).toHaveLength(1);
		const resource = fetchCalls.find((u) => u.includes("/resources/"));
		expect(resource).toContain("/open-apis/im/v1/messages/om_img/resources/img_v2_abc?type=image");
	});

	it("skips unsupported message types without emitting", async () => {
		const { fake, emitted } = await connect();
		fake.deliver({
			event_id: "aud",
			sender: { sender_id: { open_id: "ou_s" } },
			message: {
				message_id: "om_a",
				chat_id: "oc_c",
				message_type: "audio",
				content: JSON.stringify({ file_key: "f" }),
			},
		});
		await flush();
		expect(emitted).toHaveLength(0);
	});

	it("still emits a post message's text when its embedded image download fails", async () => {
		const failingFetch: LarkFetch = async (url) => {
			if (url.includes("/tenant_access_token/")) {
				return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ code: 234000, msg: "not found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		};
		const post = {
			title: "",
			content: [
				[
					{ tag: "text", text: "see this" },
					{ tag: "img", image_key: "img_missing" },
				],
			],
		};
		const postEvent = {
			event_id: "post_fail",
			sender: { sender_id: { open_id: "ou_s" } },
			message: {
				message_id: "om_p",
				chat_id: "oc_c",
				message_type: "post",
				content: JSON.stringify({ post: { zh_cn: post } }),
			},
		};
		const { fake, emitted } = await connect({ fetchImpl: failingFetch });
		fake.deliver(postEvent);
		await flush();
		expect(emitted).toHaveLength(1);
		const event = emitted[0];
		if (event.kind !== "message") throw new Error("unreachable");
		expect(event.text).toBe("see this");
		expect(event.images).toBeUndefined();
	});

	it("does not download images when downloadImages is disabled", async () => {
		const { fake, emitted, fetchCalls } = await connect({ downloadImages: false });
		fake.deliver(imageEvent("img3", "img_x"));
		await flush();
		// Image-only message with images disabled → text empty + no images → skipped.
		expect(emitted).toHaveLength(0);
		expect(fetchCalls).toHaveLength(0);
	});

	it("escalates a terminal transport drop to the gateway via signalDisconnected", async () => {
		const { fake, signals } = await connect();
		const error = new Error("ws exhausted");
		fake.drop(error);
		expect(signals).toEqual([error]);
	});

	it("disconnect() stops the transport", async () => {
		const { connector, fake } = await connect();
		await connector.disconnect();
		expect(fake.stopped).toBe(true);
	});
});
