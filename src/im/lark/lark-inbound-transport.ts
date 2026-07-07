/**
 * The inbound long-connection transport seam for Lark, plus its production implementation backed by
 * the official SDK's `WSClient` (`@larksuiteoapi/node-sdk`). Lark's persistent-connection protocol
 * is protobuf-framed over a WebSocket the SDK negotiates, pings and reconnects internally — so we
 * delegate the wire to the SDK and keep everything routing-relevant (dedup, normalization, image
 * download, emit) in the connector, which programs against this narrow seam. Tests inject a fake
 * client factory, so the connector and the lifecycle mapping are unit-testable with no real network.
 *
 * Lifecycle mapping (see the connector for the gateway contract):
 * - `start()` resolves on the SDK's `onReady` and rejects on an `onError` that fires before ready
 *   (or a connect timeout — `WSClient.start()` is fire-and-forget and silently no-ops on a malformed
 *   appId, so a timeout is the only guard against a hung connect).
 * - `autoReconnect` is left ON: the SDK owns fast in-place reconnect (a mid-session drop with it OFF
 *   is silent in the SDK, so OFF is not viable). Only a *terminal* `onError` after we were live —
 *   a non-retryable error or exhausted retries — is escalated via `onDisconnect`, letting the
 *   gateway's outer backoff take over. Deliberate `stop()` sets a flag so its close never escalates.
 */
import { Domain, EventDispatcher, type Logger, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";

import { createLogger } from "../../logging";
import { ImCredentialUnavailableError } from "../errors";
import { resolveImCredential } from "../im-credential-store";
import type { ImOutboundCredential } from "../types";
import { parseLarkBotCredential } from "./lark-message-format";

const log = createLogger("im.lark.inbound");

/** Default time to wait for the first `onReady`/`onError` before failing the connect attempt. */
export const DEFAULT_LARK_WS_CONNECT_TIMEOUT_MS = 30_000;

/** Default WebSocket handshake cap handed to the SDK, so a stuck handshake aborts and retries. */
export const DEFAULT_LARK_WS_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Callbacks the transport delivers to the connector. */
export interface LarkInboundTransportHandlers {
	/** A raw `im.message.receive_v1` handler payload (header + event merged flat). */
	onMessage(data: unknown): void;
	/** The live connection terminally dropped; the gateway should schedule a backoff reconnect. */
	onDisconnect(error?: unknown): void;
}

/** The inbound long-connection transport the connector drives. */
export interface LarkInboundTransport {
	/** Open the connection; resolve once live, reject on a fatal handshake/connect failure. */
	start(handlers: LarkInboundTransportHandlers): Promise<void>;
	/** Tear down deliberately and idempotently; must NOT trigger {@link LarkInboundTransportHandlers.onDisconnect}. */
	stop(): Promise<void>;
}

/** The subset of the SDK `WSClient` the transport uses — so tests can inject a fake. */
export interface LarkWsClientLike {
	start(params: { eventDispatcher: EventDispatcher }): unknown;
	close(params?: { force?: boolean }): void;
}

/** Constructor params passed to the injectable client factory (a superset of what the SDK needs). */
export interface LarkWsClientParams {
	appId: string;
	appSecret: string;
	domain: Domain | string;
	logger: Logger;
	loggerLevel: LoggerLevel;
	autoReconnect: boolean;
	handshakeTimeoutMs?: number;
	onReady: () => void;
	onError: (err: Error) => void;
	onReconnecting: () => void;
	onReconnected: () => void;
}

/** Factory for the underlying long-connection client. Defaults to the real SDK `WSClient`. */
export type LarkWsClientFactory = (params: LarkWsClientParams) => LarkWsClientLike;

export interface LarkWsInboundTransportOptions {
	/** Resolve the Lark credential (its `botToken` carries `app_id:app_secret`). Defaults to the store. */
	resolveCredential?: () => Promise<ImOutboundCredential | null>;
	/** OpenAPI domain. Defaults to {@link Domain.Feishu}. */
	domain?: Domain | string;
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	loggerLevel?: LoggerLevel;
	/** Underlying client factory; injected in tests. Defaults to `new WSClient(params)`. */
	createClient?: LarkWsClientFactory;
}

/** Adapt the SDK's variadic logger onto Kanban's structured logging facade (no `console.*`). */
const sdkLogger: Logger = {
	error: (...msg) => log.error(msg.map(String).join(" ")),
	warn: (...msg) => log.warn(msg.map(String).join(" ")),
	// The SDK is chatty at info (connection banners); route it to debug to keep normal logs quiet.
	info: (...msg) => log.debug(msg.map(String).join(" ")),
	debug: (...msg) => log.debug(msg.map(String).join(" ")),
	trace: () => {},
};

export class LarkWsInboundTransport implements LarkInboundTransport {
	private readonly resolveCredential: () => Promise<ImOutboundCredential | null>;
	private readonly domain: Domain | string;
	private readonly connectTimeoutMs: number;
	private readonly handshakeTimeoutMs: number;
	private readonly loggerLevel: LoggerLevel;
	private readonly createClient: LarkWsClientFactory;

	private client: LarkWsClientLike | null = null;
	private disposed = false;

	constructor(options: LarkWsInboundTransportOptions = {}) {
		this.resolveCredential = options.resolveCredential ?? (() => resolveImCredential("lark"));
		this.domain = options.domain ?? Domain.Feishu;
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_LARK_WS_CONNECT_TIMEOUT_MS;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_LARK_WS_HANDSHAKE_TIMEOUT_MS;
		this.loggerLevel = options.loggerLevel ?? LoggerLevel.warn;
		this.createClient = options.createClient ?? ((params) => new WSClient(params));
	}

	async start(handlers: LarkInboundTransportHandlers): Promise<void> {
		this.disposed = false;
		const credential = await this.resolveCredential();
		if (!credential?.botToken) {
			throw new ImCredentialUnavailableError("lark");
		}
		const { appId, appSecret } = parseLarkBotCredential(credential.botToken);

		const eventDispatcher = new EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				handlers.onMessage(data);
			},
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`lark ws connect timed out after ${this.connectTimeoutMs}ms`));
			}, this.connectTimeoutMs);
			timer.unref?.();

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};

			const onReady = () => {
				if (settled) {
					// A reconnect re-fired ready after we were already live — nothing to settle.
					log.debug("lark ws ready (reconnected)");
					return;
				}
				settle(resolve);
			};
			const onError = (err: Error) => {
				if (!settled) {
					settle(() => reject(err));
					return;
				}
				// Terminal error after we were live: escalate to the gateway unless we closed on purpose.
				if (!this.disposed) {
					handlers.onDisconnect(err);
				}
			};

			this.client = this.createClient({
				appId,
				appSecret,
				domain: this.domain,
				logger: sdkLogger,
				loggerLevel: this.loggerLevel,
				autoReconnect: true,
				handshakeTimeoutMs: this.handshakeTimeoutMs,
				onReady,
				onError,
				onReconnecting: () => log.debug("lark ws reconnecting"),
				onReconnected: () => log.debug("lark ws reconnected"),
			});

			// WSClient.start() is fire-and-forget; the callbacks above drive our promise. Guard the
			// rare synchronous/async throw so a broken client rejects the connect instead of hanging.
			Promise.resolve()
				.then(() => this.client?.start({ eventDispatcher }))
				.catch((err: unknown) => {
					settle(() => reject(err instanceof Error ? err : new Error(String(err))));
				});
		});
	}

	async stop(): Promise<void> {
		this.disposed = true;
		const client = this.client;
		this.client = null;
		if (!client) return;
		try {
			client.close({ force: true });
		} catch (error) {
			log.warn("lark ws close failed", { error });
		}
	}
}

/** Build the production SDK-backed Lark inbound transport. */
export function createLarkWsInboundTransport(options?: LarkWsInboundTransportOptions): LarkInboundTransport {
	return new LarkWsInboundTransport(options);
}
