import { describe, expect, it, vi } from "vitest";
import {
	DingtalkStreamConnector,
	type DingtalkStreamConnectorDeps,
} from "../../../../src/im/dingtalk/dingtalk-stream-connector";
import { DingtalkStreamCredentialFormatError } from "../../../../src/im/dingtalk/errors";
import type {
	DingtalkStreamSocket,
	DingtalkStreamSocketHandlers,
} from "../../../../src/im/dingtalk/dingtalk-stream-transport";
import { ImCredentialUnavailableError } from "../../../../src/im/errors";
import type { ImConnectorContext } from "../../../../src/im/gateway/im-gateway-connector";
import type { ImInboundEvent } from "../../../../src/im/gateway/inbound-event";
import type { ImOutboundCredential } from "../../../../src/im/types";

/** A fake socket that captures its handlers so the test can drive open/message/close and read sends. */
class FakeSocket implements DingtalkStreamSocket {
	sent: string[] = [];
	closed = false;
	constructor(
		readonly url: string,
		readonly handlers: DingtalkStreamSocketHandlers,
	) {}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
	}
}

interface Harness {
	connector: DingtalkStreamConnector;
	context: ImConnectorContext;
	received: ImInboundEvent[];
	dropped: unknown[];
	sockets: FakeSocket[];
	openCalls: unknown[];
}

function makeHarness(overrides: Partial<DingtalkStreamConnectorDeps> = {}): Harness {
	const sockets: FakeSocket[] = [];
	const openCalls: unknown[] = [];
	const received: ImInboundEvent[] = [];
	const dropped: unknown[] = [];

	const deps: DingtalkStreamConnectorDeps = {
		resolveCredential: async (): Promise<ImOutboundCredential | null> => ({ botToken: "appKey:appSecret" }),
		opener: {
			open: async (request) => {
				openCalls.push(request);
				return { endpoint: "wss://stream.example/connect", ticket: "tkt-1" };
			},
		},
		createSocket: (url, handlers) => {
			const socket = new FakeSocket(url, handlers);
			sockets.push(socket);
			return socket;
		},
		...overrides,
	};

	const connector = new DingtalkStreamConnector(deps);
	const context: ImConnectorContext = {
		emit: (event) => received.push(event),
		signalDisconnected: (error) => dropped.push(error),
	};
	return { connector, context, received, dropped, sockets, openCalls };
}

/** The single frame the socket most recently produced by opening + a scripted message. */
function botMessageFrame(overrides: Record<string, unknown> = {}): string {
	const data = JSON.stringify({
		conversationId: "cid-1",
		conversationType: "2",
		senderId: "sender-long",
		senderStaffId: "staff-1",
		msgtype: "text",
		text: { content: "hello" },
		msgId: "mid-1",
		...overrides,
	});
	return JSON.stringify({
		specVersion: "1.0",
		type: "CALLBACK",
		headers: { topic: "/v1.0/im/bot/messages/get", messageId: "frame-1", contentType: "application/json" },
		data,
	});
}

/** Wait (flushing microtasks) until the socket at `index` has been created, then return it. */
async function nextSocket(h: Harness, index: number): Promise<FakeSocket> {
	for (let i = 0; i < 50 && !h.sockets[index]; i++) {
		await Promise.resolve();
	}
	const socket = h.sockets[index];
	if (!socket) {
		throw new Error(`socket ${index} was never created`);
	}
	return socket;
}

/** Open a connector to the connected state and return its single live socket. */
async function connectToLive(h: Harness): Promise<FakeSocket> {
	const connecting = h.connector.connect(h.context);
	const socket = await nextSocket(h, 0);
	socket.handlers.onOpen();
	await connecting;
	return socket;
}

describe("DingtalkStreamConnector", () => {
	it("opens the endpoint with the parsed credential and connects the socket to endpoint?ticket", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		expect(h.openCalls).toHaveLength(1);
		expect(h.openCalls[0]).toMatchObject({ clientId: "appKey", clientSecret: "appSecret" });
		expect(socket.url).toBe("wss://stream.example/connect?ticket=tkt-1");
	});

	it("throws when no botToken credential is configured", async () => {
		const h = makeHarness({ resolveCredential: async () => null });
		await expect(h.connector.connect(h.context)).rejects.toBeInstanceOf(ImCredentialUnavailableError);
	});

	it("throws when the botToken is not appKey:appSecret", async () => {
		const h = makeHarness({ resolveCredential: async () => ({ botToken: "bare-token" }) });
		await expect(h.connector.connect(h.context)).rejects.toBeInstanceOf(DingtalkStreamCredentialFormatError);
	});

	it("decodes a bot message into an inbound event and acks the frame", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		socket.handlers.onMessage(botMessageFrame());

		expect(h.received).toEqual([
			{ kind: "message", platform: "dingtalk", channelKey: "cid-1", text: "hello", senderId: "staff-1" },
		]);
		const ack = JSON.parse(socket.sent.at(-1) as string);
		expect(ack.code).toBe(200);
		expect(ack.headers.messageId).toBe("frame-1");
	});

	it("answers a ping with a 200 ack echoing the ping data, without emitting", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		socket.handlers.onMessage(
			JSON.stringify({ type: "SYSTEM", headers: { topic: "ping", messageId: "ping-1" }, data: '{"t":1}' }),
		);

		expect(h.received).toHaveLength(0);
		const ack = JSON.parse(socket.sent.at(-1) as string);
		expect(ack.headers.messageId).toBe("ping-1");
		expect(ack.data).toBe('{"t":1}');
	});

	it("de-duplicates a redelivered message with the same msgId (emits once)", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		socket.handlers.onMessage(botMessageFrame());
		socket.handlers.onMessage(botMessageFrame());

		expect(h.received).toHaveLength(1);
		// Both deliveries are still acked so DingTalk stops redelivering.
		expect(socket.sent).toHaveLength(2);
	});

	it("treats distinct msgIds as distinct messages", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		socket.handlers.onMessage(botMessageFrame({ msgId: "mid-a" }));
		socket.handlers.onMessage(botMessageFrame({ msgId: "mid-b" }));

		expect(h.received).toHaveLength(2);
	});

	it("dedup survives a reconnect (same connector instance)", async () => {
		const h = makeHarness();
		const first = await connectToLive(h);
		first.handlers.onMessage(botMessageFrame());
		expect(h.received).toHaveLength(1);

		// Simulate a drop + reconnect on the same connector.
		first.handlers.onClose(new Error("drop"));
		await h.connector.disconnect();
		const secondConnecting = h.connector.connect(h.context);
		const second = await nextSocket(h, 1);
		second.handlers.onOpen();
		await secondConnecting;

		second.handlers.onMessage(botMessageFrame());
		expect(h.received).toHaveLength(1);
	});

	it("signals a disconnect when the live socket closes unexpectedly", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		socket.handlers.onClose(new Error("socket closed"));

		expect(h.dropped).toHaveLength(1);
	});

	it("does not signal a disconnect after a deliberate disconnect()", async () => {
		const h = makeHarness();
		const socket = await connectToLive(h);

		await h.connector.disconnect();
		expect(socket.closed).toBe(true);

		socket.handlers.onClose();
		expect(h.dropped).toHaveLength(0);
	});

	it("rejects connect when the socket closes before it opens", async () => {
		const h = makeHarness();
		const connecting = h.connector.connect(h.context);
		const socket = await nextSocket(h, 0);
		socket.handlers.onClose(new Error("handshake failed"));
		await expect(connecting).rejects.toBeTruthy();
	});

	it("rejects connect when the socket never opens within the timeout", async () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness({ connectTimeoutMs: 1000 });
			const connecting = h.connector.connect(h.context);
			const rejection = expect(connecting).rejects.toBeTruthy();
			await vi.advanceTimersByTimeAsync(1000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});
});
