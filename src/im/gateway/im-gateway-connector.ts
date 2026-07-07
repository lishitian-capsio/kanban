/**
 * The per-platform inbound long-connection contract — the seam a concrete platform adapter (Lark
 * WebSocket / DingTalk Stream) implements and self-registers by its {@link ImPlatform} id (see
 * `./im-gateway-connector-registry`). It mirrors the outbound {@link ImProvider} split: the
 * connector owns ONLY the platform-native transport + handshake + frame → {@link ImInboundEvent}
 * decode; the resident {@link ImGateway} owns lifecycle (start / backoff-reconnect / close). The
 * connector self-resolves its own credential from the machine-local store, exactly like the
 * outbound adapters — credentials are never passed through this interface.
 */
import type { ImPlatform } from "../types";
import type { ImInboundEvent } from "./inbound-event";

/**
 * Lifecycle state of a single platform's long connection, surfaced for status / UI:
 * - `idle` — not started (no credential, or the gateway hasn't started it);
 * - `connecting` — the initial connect attempt is in flight;
 * - `connected` — the long connection is live;
 * - `reconnecting` — the connection dropped and a backoff retry is pending;
 * - `closed` — the gateway was stopped; the connection will not be retried.
 */
export type ImConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/**
 * The runtime handed to a connector for a single connect cycle. The connector pushes decoded
 * inbound events through {@link emit} and MUST call {@link signalDisconnected} when its underlying
 * long connection drops unexpectedly, so the gateway can schedule a backoff reconnect. A connection
 * torn down deliberately via {@link ImGatewayConnector.disconnect} must NOT call signalDisconnected.
 *
 * The gateway ignores {@link emit} / {@link signalDisconnected} calls from a stale cycle (after a
 * reconnect or a stop), so a connector that fires them late cannot corrupt gateway state.
 */
export interface ImConnectorContext {
	/** Deliver a normalized inbound event to the gateway's subscribers. */
	emit(event: ImInboundEvent): void;
	/** Signal that the live long connection dropped; the gateway schedules a backoff reconnect. */
	signalDisconnected(error?: unknown): void;
}

/** A per-platform inbound long-connection adapter. Concrete implementations live in later tasks. */
export interface ImGatewayConnector {
	/** The platform this connector serves. The registry and the gateway key on this value. */
	readonly platform: ImPlatform;
	/**
	 * Open the long connection and begin delivering events via `context`. Resolves once the
	 * connection is live; rejects on a fatal handshake failure (the gateway then schedules a
	 * backoff reconnect, same as an unexpected drop).
	 */
	connect(context: ImConnectorContext): Promise<void>;
	/**
	 * Tear down the current connection deliberately and release its resources. Called by the
	 * gateway on stop and before a reconnect. Must be idempotent and must NOT invoke
	 * {@link ImConnectorContext.signalDisconnected}.
	 */
	disconnect(): Promise<void>;
}
