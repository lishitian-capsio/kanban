import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";

import { ImCredentialUnavailableError } from "../../../src/im/errors";
import { LarkCredentialFormatError } from "../../../src/im/lark/errors";
import {
	type LarkWsClientLike,
	type LarkWsClientParams,
	LarkWsInboundTransport,
} from "../../../src/im/lark/lark-inbound-transport";

/** Capture the params (and thus the SDK callbacks) handed to the injected client factory. */
function makeClientHarness() {
	let params: LarkWsClientParams | null = null;
	let startCount = 0;
	let closedForce: boolean | undefined;
	let dispatcher: EventDispatcher | null = null;
	const client: LarkWsClientLike = {
		start(p) {
			startCount += 1;
			dispatcher = p.eventDispatcher;
		},
		close(p) {
			closedForce = p?.force;
		},
	};
	const createClient = (p: LarkWsClientParams) => {
		params = p;
		return client;
	};
	return {
		createClient,
		get params() {
			if (!params) throw new Error("client not created yet");
			return params;
		},
		get startCount() {
			return startCount;
		},
		get closedForce() {
			return closedForce;
		},
		get dispatcher() {
			if (!dispatcher) throw new Error("client not started yet");
			return dispatcher;
		},
	};
}

function makeTransport(
	harness: ReturnType<typeof makeClientHarness>,
	credential: { botToken?: string } | null = { botToken: "cli_app:secret" },
) {
	return new LarkWsInboundTransport({
		resolveCredential: async () => credential,
		connectTimeoutMs: 50,
		createClient: harness.createClient,
	});
}

const handlers = () => ({ onMessage: vi.fn(), onDisconnect: vi.fn() });

describe("LarkWsInboundTransport lifecycle", () => {
	it("resolves start() when the SDK fires onReady, and starts the client", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		const promise = transport.start(handlers());
		await Promise.resolve(); // let start() create the client
		harness.params.onReady();
		await expect(promise).resolves.toBeUndefined();
		expect(harness.startCount).toBe(1);
		expect(harness.params.autoReconnect).toBe(true);
		expect(harness.params.appId).toBe("cli_app");
		expect(harness.params.appSecret).toBe("secret");
	});

	it("rejects start() when onError fires before ready", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		const promise = transport.start(handlers());
		await Promise.resolve();
		harness.params.onError(new Error("handshake failed"));
		await expect(promise).rejects.toThrow("handshake failed");
	});

	it("rejects start() on a connect timeout when neither callback fires", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		await expect(transport.start(handlers())).rejects.toThrow(/timed out/);
	});

	it("escalates a terminal onError after ready via onDisconnect (does not reject the settled start)", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		const h = handlers();
		const promise = transport.start(h);
		await Promise.resolve();
		harness.params.onReady();
		await promise;
		const terminal = new Error("reconnect exhausted");
		harness.params.onError(terminal);
		expect(h.onDisconnect).toHaveBeenCalledWith(terminal);
	});

	it("does not escalate onError after a deliberate stop()", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		const h = handlers();
		const promise = transport.start(h);
		await Promise.resolve();
		harness.params.onReady();
		await promise;
		await transport.stop();
		expect(harness.closedForce).toBe(true);
		harness.params.onError(new Error("late"));
		expect(h.onDisconnect).not.toHaveBeenCalled();
	});

	it("registers im.message.receive_v1 on the dispatcher and forwards the merged data to onMessage", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness);
		const h = handlers();
		const promise = transport.start(h);
		await Promise.resolve();
		harness.params.onReady();
		await promise;
		// Invoke the REAL SDK EventDispatcher exactly as it would over the wire (v2 envelope, no verify).
		const raw = {
			schema: "2.0",
			header: { event_type: "im.message.receive_v1", event_id: "evt_wire" },
			event: { sender: { sender_id: { open_id: "ou_x" } }, message: { chat_id: "oc_x" } },
		};
		await harness.dispatcher.invoke(raw, { needCheck: false });
		expect(h.onMessage).toHaveBeenCalledTimes(1);
		expect(h.onMessage.mock.calls[0][0]).toMatchObject({ event_id: "evt_wire", message: { chat_id: "oc_x" } });
	});

	it("throws ImCredentialUnavailableError when no bot credential is stored", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness, { botToken: undefined });
		await expect(transport.start(handlers())).rejects.toBeInstanceOf(ImCredentialUnavailableError);
	});

	it("throws LarkCredentialFormatError when botToken is not app_id:app_secret", async () => {
		const harness = makeClientHarness();
		const transport = makeTransport(harness, { botToken: "no-colon" });
		await expect(transport.start(handlers())).rejects.toBeInstanceOf(LarkCredentialFormatError);
	});
});
