/**
 * Lark inbound {@link ImGatewayConnector} — subscribes to `im.message.receive_v1` over a persistent
 * connection (no public callback URL) and delivers normalized messages to the resident IM gateway.
 *
 * Responsibilities (the platform-neutral half of the inbound seam; the wire lives in the transport):
 * - **Idempotent dedup by `event_id`** — Lark delivers at-least-once, so a bounded FIFO of seen
 *   event ids (instance-level, so it survives the SDK's in-place reconnects) drops re-deliveries.
 * - **Normalization** — `im.message.receive_v1` → the gateway's {@link ImInboundMessageEvent}
 *   (chat_id → `channelKey`, sender open_id → `senderId`, text/post → `text`, images → `images`).
 * - **Attachment download** — message images are fetched via the message-resource API with a
 *   `tenant_access_token` and base64-encoded, so the consumer needs no Lark SDK. A download failure
 *   degrades to emitting the message without that image, never dropping the message.
 *
 * Reconnect is NOT owned here: the SDK does fast in-place reconnect, and a terminal drop is escalated
 * (via the transport's `onDisconnect`) to `context.signalDisconnected`, so the gateway's backoff is
 * the single outer authority (mirrors the gateway foundation contract). `disconnect()` is idempotent
 * and never signals a drop. The transport, fetch, credential resolver and token minter are injectable,
 * so the whole connector is unit-testable against fakes with no real network.
 */
import { createLogger } from "../../logging";
import type { ImConnectorContext, ImGatewayConnector } from "../gateway/im-gateway-connector";
import { registerImGatewayConnector } from "../gateway/im-gateway-connector-registry";
import type { ImInboundImage, ImInboundMessageEvent } from "../gateway/inbound-event";
import { resolveImCredential } from "../im-credential-store";
import type { ImOutboundCredential, ImPlatform } from "../types";
import { buildLarkMessageResourceUrl, DEFAULT_LARK_BASE_URL } from "./lark-endpoints";
import { type LarkFetch, larkGetBinary } from "./lark-http";
import {
	type NormalizedLarkImageRef,
	type NormalizedLarkInboundMessage,
	normalizeLarkInboundMessage,
	parseLarkInboundEventId,
} from "./lark-inbound-message";
import { createLarkWsInboundTransport, type LarkInboundTransport } from "./lark-inbound-transport";
import { LarkTenantTokenProvider } from "./lark-tenant-token";

const log = createLogger("im.lark.inbound");

/** Default cap on the seen-`event_id` FIFO; large enough to cover any realistic redelivery window. */
export const DEFAULT_LARK_DEDUP_CAPACITY = 1000;

export interface LarkImGatewayConnectorOptions {
	/** Inbound transport. Defaults to the SDK-backed WebSocket transport. */
	transport?: LarkInboundTransport;
	/** Transport for image downloads. Defaults to the global (proxy-aware) `fetch`. */
	fetchImpl?: LarkFetch;
	/** OpenAPI base URL. Defaults to {@link DEFAULT_LARK_BASE_URL}. */
	baseUrl?: string;
	/** Resolve the Lark credential. Defaults to the machine-local 0600 store. */
	resolveCredential?: () => Promise<ImOutboundCredential | null>;
	/** Token minter for image downloads. Defaults to one built from the options above. */
	tokenProvider?: LarkTenantTokenProvider;
	/** Cap on the seen-`event_id` FIFO. Defaults to {@link DEFAULT_LARK_DEDUP_CAPACITY}. */
	dedupCapacity?: number;
	/** Whether to download + base64-encode message images. Defaults to `true`. */
	downloadImages?: boolean;
	/** Clock for the token provider; injected for deterministic tests. */
	now?: () => number;
}

export class LarkImGatewayConnector implements ImGatewayConnector {
	readonly platform: ImPlatform = "lark";

	private readonly transport: LarkInboundTransport;
	private readonly fetchImpl: LarkFetch;
	private readonly baseUrl: string;
	private readonly tokenProvider: LarkTenantTokenProvider;
	private readonly dedupCapacity: number;
	private readonly imageDownloadEnabled: boolean;
	private readonly seenEventIds = new Set<string>();
	private context: ImConnectorContext | null = null;

	constructor(options: LarkImGatewayConnectorOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_LARK_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		const resolveCredential = options.resolveCredential ?? (() => resolveImCredential("lark"));
		this.tokenProvider =
			options.tokenProvider ??
			new LarkTenantTokenProvider({
				fetchImpl: this.fetchImpl,
				baseUrl: this.baseUrl,
				resolveCredential,
				now: options.now,
			});
		this.transport = options.transport ?? createLarkWsInboundTransport({ resolveCredential });
		this.dedupCapacity = options.dedupCapacity ?? DEFAULT_LARK_DEDUP_CAPACITY;
		this.imageDownloadEnabled = options.downloadImages ?? true;
	}

	async connect(context: ImConnectorContext): Promise<void> {
		this.context = context;
		await this.transport.start({
			onMessage: (data) => this.handleInbound(data),
			onDisconnect: (error) => context.signalDisconnected(error),
		});
	}

	async disconnect(): Promise<void> {
		this.context = null;
		await this.transport.stop();
	}

	/** Dedup + normalize a raw event, then (async) download images and emit. Never throws to the transport. */
	private handleInbound(data: unknown): void {
		// Dedup synchronously — before any await — so rapid re-deliveries of one event_id collapse.
		const eventId = parseLarkInboundEventId(data);
		if (eventId !== undefined) {
			if (this.seenEventIds.has(eventId)) {
				log.debug("skipping duplicate lark inbound event", { eventId });
				return;
			}
			this.rememberEventId(eventId);
		}
		const normalized = normalizeLarkInboundMessage(data);
		if (!normalized) {
			return;
		}
		void this.emitMessage(normalized).catch((error) => {
			log.warn("failed to process lark inbound message", { error });
		});
	}

	private rememberEventId(eventId: string): void {
		this.seenEventIds.add(eventId);
		while (this.seenEventIds.size > this.dedupCapacity) {
			const oldest = this.seenEventIds.values().next().value;
			if (oldest === undefined) {
				break;
			}
			this.seenEventIds.delete(oldest);
		}
	}

	private async emitMessage(normalized: NormalizedLarkInboundMessage): Promise<void> {
		const images = this.imageDownloadEnabled ? await this.downloadInboundImages(normalized.images) : [];
		const context = this.context;
		if (!context) {
			// Disconnected while the images were downloading; drop rather than emit onto a dead cycle.
			return;
		}
		if (normalized.text === "" && images.length === 0) {
			// Nothing deliverable — e.g. an images-only message whose download failed or is disabled.
			// (A message that still has text is emitted even when its images failed.)
			return;
		}
		const event: ImInboundMessageEvent = {
			kind: "message",
			platform: this.platform,
			channelKey: normalized.channelKey,
			text: normalized.text,
			senderId: normalized.senderId,
			...(images.length > 0 ? { images } : {}),
		};
		context.emit(event);
	}

	/** Download + base64-encode each image; a per-image failure is logged and skipped, not fatal. */
	private async downloadInboundImages(refs: NormalizedLarkImageRef[]): Promise<ImInboundImage[]> {
		if (refs.length === 0) {
			return [];
		}
		let token: string;
		try {
			token = await this.tokenProvider.getToken();
		} catch (error) {
			log.warn("cannot mint token to download lark images; emitting message without them", { error });
			return [];
		}
		const images: ImInboundImage[] = [];
		for (const ref of refs) {
			try {
				const url = buildLarkMessageResourceUrl(this.baseUrl, ref.messageId, ref.fileKey, "image");
				const { bytes, mimeType } = await larkGetBinary(this.fetchImpl, url, {
					headers: { Authorization: `Bearer ${token}` },
				});
				images.push({ mimeType, dataBase64: Buffer.from(bytes).toString("base64") });
			} catch (error) {
				log.warn("failed to download lark inbound image; skipping it", { error });
			}
		}
		return images;
	}
}

/**
 * Construct a {@link LarkImGatewayConnector} and register it in the platform-keyed connector
 * registry. Safe to call unconditionally at startup — the resident gateway only brings it up when a
 * `lark` credential is stored, so it stays dormant otherwise.
 */
export function registerLarkImGatewayConnector(options?: LarkImGatewayConnectorOptions): LarkImGatewayConnector {
	const connector = new LarkImGatewayConnector(options);
	registerImGatewayConnector(connector);
	log.debug("registered lark im gateway connector");
	return connector;
}
