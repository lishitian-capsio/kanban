/**
 * DingTalk **Stream-mode** inbound {@link ImGatewayConnector} — the long-connection adapter that
 * receives group and single-chat bot messages over a DingTalk Stream WebSocket and normalizes them
 * into {@link ImInboundEvent}s for the resident {@link ImGateway}. It is the DingTalk counterpart to
 * the Lark WebSocket connector, built on the same seam: the connector owns ONLY the platform-native
 * transport + handshake + frame decode; the gateway owns lifecycle (start / backoff-reconnect /
 * close), so this class deliberately does NOT re-implement reconnection.
 *
 * Auth: Stream mode uses an **enterprise-bot** app credential (`appKey` + `appSecret`), stored
 * colon-joined in the machine-local (0600) IM credential store's opaque `botToken`
 * (`"<appKey>:<appSecret>"`), exactly like the Lark adapter. A webhook-only credential (the outbound
 * custom-robot path) cannot open a Stream connection and surfaces a
 * {@link DingtalkStreamCredentialFormatError} on connect.
 *
 * Connect flow: resolve + parse the credential → POST the Stream open endpoint for an
 * `endpoint`+`ticket` → connect a WebSocket to `endpoint?ticket=…` → resolve once the socket opens.
 * Downstream, it acks every frame (so DingTalk stops redelivering), answers keep-alive pings, and on
 * a bot-message frame decodes + de-duplicates (at-least-once delivery ⇒ idempotent dedup on the
 * message's `msgId`, falling back to the frame id) before emitting. All collaborators are injected
 * with production defaults, so the whole connector is unit-testable with a fake opener + fake socket.
 */
import { createLogger } from "../../logging";
import { ImCredentialUnavailableError } from "../errors";
import type { ImConnectorContext, ImGatewayConnector } from "../gateway/im-gateway-connector";
import { registerImGatewayConnector } from "../gateway/im-gateway-connector-registry";
import { resolveImCredential } from "../im-credential-store";
import type { ImOutboundCredential, ImPlatform } from "../types";
import {
	buildDingtalkAckFrame,
	buildDingtalkOpenRequest,
	decodeDingtalkBotMessage,
	isDingtalkBotMessageFrame,
	isDingtalkDisconnectFrame,
	isDingtalkPingFrame,
	parseDingtalkStreamCredential,
	parseDingtalkStreamFrame,
} from "./dingtalk-stream-protocol";
import {
	createDefaultDingtalkStreamOpener,
	createDefaultDingtalkStreamSocketFactory,
	type DingtalkStreamOpener,
	type DingtalkStreamSocket,
	type DingtalkStreamSocketFactory,
} from "./dingtalk-stream-transport";
import { DingtalkStreamOpenError } from "./errors";

const log = createLogger("im.dingtalk.stream");

/** How long to wait for the WebSocket handshake before failing the connect attempt. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** Cap on the number of recently-seen message ids retained for idempotent dedup. */
const DEFAULT_DEDUP_CAPACITY = 500;

export interface DingtalkStreamConnectorDeps {
	/** Self-resolve the DingTalk credential (default: the machine-local 0600 store). */
	resolveCredential?: () => Promise<ImOutboundCredential | null>;
	/** Opens the Stream connection endpoint (default: proxy-aware global `fetch`). */
	opener?: DingtalkStreamOpener;
	/** Creates the live WebSocket (default: wraps the global `WebSocket`). */
	createSocket?: DingtalkStreamSocketFactory;
	/** Handshake timeout in ms; `0` disables it. */
	connectTimeoutMs?: number;
	/** Recently-seen-id retention for dedup. */
	dedupCapacity?: number;
}

/** A bounded FIFO set of recently-seen ids for idempotent dedup of at-least-once redeliveries. */
class SeenIdSet {
	private readonly set = new Set<string>();
	private readonly order: string[] = [];
	constructor(private readonly capacity: number) {}

	/** Record `id`; returns `true` if it was already present (a duplicate). */
	seen(id: string): boolean {
		if (this.set.has(id)) {
			return true;
		}
		this.set.add(id);
		this.order.push(id);
		if (this.order.length > this.capacity) {
			const evicted = this.order.shift();
			if (evicted !== undefined) {
				this.set.delete(evicted);
			}
		}
		return false;
	}
}

export class DingtalkStreamConnector implements ImGatewayConnector {
	readonly platform: ImPlatform = "dingtalk";

	private readonly resolveCredential: () => Promise<ImOutboundCredential | null>;
	private readonly opener: DingtalkStreamOpener;
	private readonly createSocket: DingtalkStreamSocketFactory;
	private readonly connectTimeoutMs: number;
	private readonly seen: SeenIdSet;

	private socket: DingtalkStreamSocket | null = null;
	/** Set while a `disconnect()` is in progress so the socket's own close does not signal a drop. */
	private deliberatelyClosed = false;

	constructor(deps: DingtalkStreamConnectorDeps = {}) {
		this.resolveCredential = deps.resolveCredential ?? (() => resolveImCredential("dingtalk"));
		this.opener = deps.opener ?? createDefaultDingtalkStreamOpener();
		this.createSocket = deps.createSocket ?? createDefaultDingtalkStreamSocketFactory();
		this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		this.seen = new SeenIdSet(deps.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY);
	}

	async connect(context: ImConnectorContext): Promise<void> {
		this.deliberatelyClosed = false;

		const credential = await this.resolveCredential();
		if (!credential?.botToken) {
			// Stream mode needs an app credential; a webhook-only credential can't open a connection.
			throw new ImCredentialUnavailableError(this.platform);
		}
		const parsed = parseDingtalkStreamCredential(credential.botToken);
		const { endpoint, ticket } = await this.opener.open(buildDingtalkOpenRequest(parsed));
		const url = appendTicket(endpoint, ticket);

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				fn();
			};

			const socket = this.createSocket(url, {
				onOpen: () => finish(resolve),
				onMessage: (data) => this.handleFrame(data, context),
				onClose: (error) => {
					if (!settled) {
						finish(() => reject(new DingtalkStreamOpenError("socket closed before handshake completed")));
						return;
					}
					if (!this.deliberatelyClosed) {
						context.signalDisconnected(error);
					}
				},
			});
			this.socket = socket;

			if (this.connectTimeoutMs > 0) {
				timer = setTimeout(() => {
					finish(() => reject(new DingtalkStreamOpenError(`handshake timed out after ${this.connectTimeoutMs}ms`)));
				}, this.connectTimeoutMs);
				timer.unref?.();
			}
		});
	}

	async disconnect(): Promise<void> {
		this.deliberatelyClosed = true;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			try {
				socket.close();
			} catch (error) {
				log.debug("dingtalk stream socket close failed", { error });
			}
		}
	}

	/** Decode one downstream frame: ack it, answer pings, react to disconnect, emit bot messages. */
	private handleFrame(raw: string, context: ImConnectorContext): void {
		const frame = parseDingtalkStreamFrame(raw);
		if (!frame) {
			return;
		}

		if (isDingtalkPingFrame(frame)) {
			// A ping is answered by echoing its own data back in the ack (the pong).
			this.ack(frame.messageId, frame.data);
			return;
		}

		// Ack every non-ping frame so DingTalk stops redelivering it, then act on it.
		this.ack(frame.messageId);

		if (isDingtalkDisconnectFrame(frame)) {
			// The server is asking us to reconnect; hand off to the gateway's backoff supervisor.
			if (!this.deliberatelyClosed) {
				context.signalDisconnected(new DingtalkStreamOpenError("server requested disconnect"));
			}
			return;
		}

		if (!isDingtalkBotMessageFrame(frame)) {
			return;
		}

		const decoded = decodeDingtalkBotMessage(frame.data);
		if (!decoded) {
			return;
		}
		// At-least-once delivery ⇒ dedup on the stable message id, falling back to the frame id when
		// the payload omitted `msgId`, so a redelivered message is emitted to consumers only once.
		const dedupKey = decoded.dedupKey || frame.messageId;
		if (this.seen.seen(dedupKey)) {
			return;
		}
		context.emit(decoded.event);
	}

	private ack(messageId: string, data?: string): void {
		try {
			this.socket?.send(buildDingtalkAckFrame(messageId, data));
		} catch (error) {
			log.debug("dingtalk stream ack send failed", { error });
		}
	}
}

/** Append the one-time `ticket` query param to the Stream WebSocket endpoint. */
function appendTicket(endpoint: string, ticket: string): string {
	const separator = endpoint.includes("?") ? "&" : "?";
	return `${endpoint}${separator}ticket=${encodeURIComponent(ticket)}`;
}

/**
 * Construct the default (production) DingTalk Stream connector and register it under the `dingtalk`
 * id so the resident {@link ImGateway} brings it up when a DingTalk credential is stored. Safe to
 * call unconditionally at startup: the credential is resolved lazily on connect, and the gateway
 * skips the platform entirely when no credential is configured.
 */
export function registerDingtalkStreamConnector(deps?: DingtalkStreamConnectorDeps): DingtalkStreamConnector {
	const connector = new DingtalkStreamConnector(deps);
	registerImGatewayConnector(connector);
	log.debug("registered dingtalk stream inbound connector");
	return connector;
}
