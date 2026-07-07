import { describe, expect, it } from "vitest";
import { ImGateway } from "../../../../src/im/gateway/im-gateway";
import type { ImConnectorContext, ImGatewayConnector } from "../../../../src/im/gateway/im-gateway-connector";
import type { ImInboundEvent, ImInboundMessageEvent } from "../../../../src/im/gateway/inbound-event";
import type { ImPlatform } from "../../../../src/im/types";

/** Let queued microtasks (the awaited connect attempt inside a fired reconnect) settle. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

type ConnectOutcome = "resolve" | "reject";

/** A controllable in-memory connector: it captures its context and follows a scripted outcome queue. */
class FakeConnector implements ImGatewayConnector {
	connectCount = 0;
	disconnectCount = 0;
	context: ImConnectorContext | null = null;
	private readonly outcomes: ConnectOutcome[];
	private readonly defaultOutcome: ConnectOutcome;

	constructor(
		readonly platform: ImPlatform,
		options: { outcomes?: ConnectOutcome[]; defaultOutcome?: ConnectOutcome } = {},
	) {
		this.outcomes = [...(options.outcomes ?? [])];
		this.defaultOutcome = options.defaultOutcome ?? "resolve";
	}

	async connect(context: ImConnectorContext): Promise<void> {
		this.connectCount += 1;
		this.context = context;
		const outcome = this.outcomes.shift() ?? this.defaultOutcome;
		if (outcome === "reject") {
			throw new Error("simulated connect failure");
		}
	}

	async disconnect(): Promise<void> {
		this.disconnectCount += 1;
	}
}

interface ScheduledTimer {
	delayMs: number;
	run: () => void;
	canceled: boolean;
}

/** A manual scheduler so backoff timing is deterministic without wall-clock delays. */
function makeManualScheduler() {
	const pending: ScheduledTimer[] = [];
	const scheduleReconnect = (delayMs: number, run: () => void): (() => void) => {
		const entry: ScheduledTimer = { delayMs, run, canceled: false };
		pending.push(entry);
		return () => {
			entry.canceled = true;
		};
	};
	const fireNext = (): void => {
		const entry = pending.shift();
		if (entry && !entry.canceled) {
			entry.run();
		}
	};
	return { pending, scheduleReconnect, fireNext };
}

interface Harness {
	gateway: ImGateway;
	scheduler: ReturnType<typeof makeManualScheduler>;
}

function makeGateway(
	connectors: Map<ImPlatform, ImGatewayConnector>,
	credentialed: Set<ImPlatform>,
	reconnectDelaysMs: number[] = [10, 20, 50],
): Harness {
	const scheduler = makeManualScheduler();
	const gateway = new ImGateway({
		hasCredential: async (platform) => credentialed.has(platform),
		listConnectorPlatforms: () => [...connectors.keys()],
		getConnector: (platform) => connectors.get(platform) ?? null,
		reconnectDelaysMs,
		scheduleReconnect: scheduler.scheduleReconnect,
	});
	return { gateway, scheduler };
}

const SAMPLE_MESSAGE: ImInboundMessageEvent = {
	kind: "message",
	platform: "lark",
	channelKey: "oc_abc",
	text: "hello",
	senderId: "ou_123",
};

describe("ImGateway", () => {
	it("starts a registered, credentialed connector and reports it connected", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();

		expect(lark.connectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("skips a registered connector with no stored credential", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set());

		await gateway.start();

		expect(lark.connectCount).toBe(0);
		expect(gateway.getConnectionState("lark")).toBe("idle");
	});

	it("is idempotent — a second start() does not double-connect", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();
		await gateway.start();

		expect(lark.connectCount).toBe(1);
	});

	it("delivers inbound events a connector emits to onInboundEvent subscribers", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));
		const received: ImInboundEvent[] = [];
		gateway.onInboundEvent((event) => received.push(event));

		await gateway.start();
		lark.context?.emit(SAMPLE_MESSAGE);

		expect(received).toEqual([SAMPLE_MESSAGE]);
	});

	it("onInboundEvent returns an unsubscribe that stops further delivery", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));
		const received: ImInboundEvent[] = [];
		const off = gateway.onInboundEvent((event) => received.push(event));

		await gateway.start();
		lark.context?.emit(SAMPLE_MESSAGE);
		off();
		lark.context?.emit({ ...SAMPLE_MESSAGE, text: "second" });

		expect(received).toEqual([SAMPLE_MESSAGE]);
	});

	it("schedules a backoff reconnect when a live connection drops, then reconnects", async () => {
		const lark = new FakeConnector("lark");
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();
		expect(gateway.getConnectionState("lark")).toBe("connected");

		lark.context?.signalDisconnected(new Error("socket closed"));
		expect(gateway.getConnectionState("lark")).toBe("reconnecting");
		expect(scheduler.pending).toHaveLength(1);
		expect(scheduler.pending[0]?.delayMs).toBe(10);

		scheduler.fireNext();
		await flush();

		expect(lark.connectCount).toBe(2);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("increases the backoff delay while connect keeps failing, capped at the last delay", async () => {
		const lark = new FakeConnector("lark", { defaultOutcome: "reject" });
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]), [10, 20, 50]);

		await gateway.start();
		expect(gateway.getConnectionState("lark")).toBe("reconnecting");
		expect(scheduler.pending[0]?.delayMs).toBe(10);

		scheduler.fireNext();
		await flush();
		expect(scheduler.pending[0]?.delayMs).toBe(20);

		scheduler.fireNext();
		await flush();
		expect(scheduler.pending[0]?.delayMs).toBe(50);

		scheduler.fireNext();
		await flush();
		expect(scheduler.pending[0]?.delayMs).toBe(50);
	});

	it("resets the backoff after a successful reconnect", async () => {
		const lark = new FakeConnector("lark", { outcomes: ["reject", "reject", "resolve"] });
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]), [10, 20, 50]);

		await gateway.start();
		scheduler.fireNext();
		await flush();
		scheduler.fireNext();
		await flush();
		expect(gateway.getConnectionState("lark")).toBe("connected");

		lark.context?.signalDisconnected();
		expect(scheduler.pending.at(-1)?.delayMs).toBe(10);
	});

	it("stop() cancels a pending reconnect, disconnects the connector, and ignores a late drop signal", async () => {
		const lark = new FakeConnector("lark");
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();
		await gateway.stop();

		expect(lark.disconnectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("closed");

		lark.context?.signalDisconnected();
		expect(scheduler.pending).toHaveLength(0);
	});

	it("stop() cancels an in-flight reconnect timer so no further connect is attempted", async () => {
		const lark = new FakeConnector("lark", { defaultOutcome: "reject" });
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();
		expect(scheduler.pending).toHaveLength(1);

		await gateway.stop();
		expect(scheduler.pending[0]?.canceled).toBe(true);

		scheduler.fireNext();
		await flush();
		expect(lark.connectCount).toBe(1);
	});
});

describe("ImGateway.refresh", () => {
	it("brings up a platform whose credential appears after start()", async () => {
		const lark = new FakeConnector("lark");
		const credentialed = new Set<ImPlatform>();
		const { gateway } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		expect(lark.connectCount).toBe(0);
		expect(gateway.getConnectionState("lark")).toBe("idle");

		credentialed.add("lark");
		await gateway.refresh();

		expect(lark.connectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("stops and disconnects a platform whose credential was cleared", async () => {
		const lark = new FakeConnector("lark");
		const credentialed = new Set<ImPlatform>(["lark"]);
		const { gateway } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		expect(gateway.getConnectionState("lark")).toBe("connected");

		credentialed.delete("lark");
		await gateway.refresh();

		expect(lark.disconnectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("idle");
	});

	it("cancels a pending reconnect when the credential is cleared", async () => {
		const lark = new FakeConnector("lark", { defaultOutcome: "reject" });
		const credentialed = new Set<ImPlatform>(["lark"]);
		const { gateway, scheduler } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		expect(scheduler.pending).toHaveLength(1);

		credentialed.delete("lark");
		await gateway.refresh();

		expect(scheduler.pending[0]?.canceled).toBe(true);
		expect(gateway.getConnectionState("lark")).toBe("idle");
	});

	it("is a no-op when nothing changed — does not reconnect an already-connected platform", async () => {
		const lark = new FakeConnector("lark");
		const { gateway } = makeGateway(new Map([["lark", lark]]), new Set(["lark"]));

		await gateway.start();
		await gateway.refresh();
		await gateway.refresh();

		expect(lark.connectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("only touches the platform whose credential changed, leaving others connected", async () => {
		const lark = new FakeConnector("lark");
		const dingtalk = new FakeConnector("dingtalk");
		const credentialed = new Set<ImPlatform>(["lark"]);
		const { gateway } = makeGateway(
			new Map<ImPlatform, ImGatewayConnector>([
				["lark", lark],
				["dingtalk", dingtalk],
			]),
			credentialed,
		);

		await gateway.start();
		expect(lark.connectCount).toBe(1);
		expect(dingtalk.connectCount).toBe(0);

		credentialed.add("dingtalk");
		await gateway.refresh();

		expect(dingtalk.connectCount).toBe(1);
		expect(gateway.getConnectionState("dingtalk")).toBe("connected");
		// lark was untouched — no reconnect churn.
		expect(lark.connectCount).toBe(1);
		expect(lark.disconnectCount).toBe(0);
	});

	it("coalesces concurrent refresh() calls so a newly-credentialed platform connects once", async () => {
		const lark = new FakeConnector("lark");
		const credentialed = new Set<ImPlatform>();
		const { gateway } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		credentialed.add("lark");

		await Promise.all([gateway.refresh(), gateway.refresh(), gateway.refresh()]);

		expect(lark.connectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("re-adds a platform after its credential is cleared and later restored", async () => {
		const lark = new FakeConnector("lark");
		const credentialed = new Set<ImPlatform>(["lark"]);
		const { gateway } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		credentialed.delete("lark");
		await gateway.refresh();
		expect(gateway.getConnectionState("lark")).toBe("idle");

		credentialed.add("lark");
		await gateway.refresh();

		expect(lark.connectCount).toBe(2);
		expect(gateway.getConnectionState("lark")).toBe("connected");
	});

	it("does not bring connections back up after stop()", async () => {
		const lark = new FakeConnector("lark");
		const credentialed = new Set<ImPlatform>(["lark"]);
		const { gateway } = makeGateway(new Map([["lark", lark]]), credentialed);

		await gateway.start();
		await gateway.stop();
		expect(lark.disconnectCount).toBe(1);

		await gateway.refresh();

		expect(lark.connectCount).toBe(1);
		expect(gateway.getConnectionState("lark")).toBe("closed");
	});

	it("never rejects when the credential check throws", async () => {
		const lark = new FakeConnector("lark");
		const gateway = new ImGateway({
			hasCredential: async () => {
				throw new Error("credential store unavailable");
			},
			listConnectorPlatforms: () => ["lark"],
			getConnector: () => lark,
			scheduleReconnect: () => () => {},
		});

		await expect(gateway.refresh()).resolves.toBeUndefined();
		expect(lark.connectCount).toBe(0);
	});
});
