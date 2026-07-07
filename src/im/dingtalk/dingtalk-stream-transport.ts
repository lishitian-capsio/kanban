/**
 * Network seams for the DingTalk Stream-mode inbound connector: the HTTP call that opens a Stream
 * connection endpoint, and the WebSocket factory the connector drives. Both are behind interfaces so
 * the connector is unit-testable with fakes (no real network / socket), mirroring how the outbound
 * adapter isolates its single HTTP POST behind {@link ./dingtalk-transport}.
 */
import { DingtalkStreamOpenError } from "./errors";
import { type DingtalkOpenRequest, DINGTALK_STREAM_OPEN_ENDPOINT } from "./dingtalk-stream-protocol";

/** The WebSocket endpoint + one-time ticket returned by the Stream open call. */
export interface DingtalkStreamEndpoint {
	endpoint: string;
	ticket: string;
}

/** Opens a Stream connection endpoint for an app credential. */
export interface DingtalkStreamOpener {
	open(request: DingtalkOpenRequest): Promise<DingtalkStreamEndpoint>;
}

/** Lifecycle callbacks the connector registers on a socket for a single connect cycle. */
export interface DingtalkStreamSocketHandlers {
	/** The socket handshake completed and the connection is live. */
	onOpen: () => void;
	/** A downstream text frame arrived (already decoded to a UTF-8 string). */
	onMessage: (data: string) => void;
	/** The socket closed (cleanly or on error). Fires at most once per socket. */
	onClose: (error?: unknown) => void;
}

/** The minimal socket surface the connector needs — satisfied by a `WebSocket` wrapper and fakes. */
export interface DingtalkStreamSocket {
	send(data: string): void;
	close(): void;
}

/** Create a live socket to `url`, wiring the given handlers. */
export type DingtalkStreamSocketFactory = (
	url: string,
	handlers: DingtalkStreamSocketHandlers,
) => DingtalkStreamSocket;

/** Per-request timeout for the Stream open HTTP call. */
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Default opener using the runtime's global `fetch` (proxy-aware, monkey-patched at startup). Throws
 * {@link DingtalkStreamOpenError} on a non-2xx status, a non-object body, or a body missing the
 * `endpoint` / `ticket`. Never logs the request body (it carries the app secret).
 */
export function createDefaultDingtalkStreamOpener(
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = DEFAULT_OPEN_TIMEOUT_MS,
): DingtalkStreamOpener {
	return {
		async open(request: DingtalkOpenRequest): Promise<DingtalkStreamEndpoint> {
			let response: Response;
			try {
				response = await fetchImpl(DINGTALK_STREAM_OPEN_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(request),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				if (error instanceof DOMException && error.name === "TimeoutError") {
					throw new DingtalkStreamOpenError(`open request timed out after ${timeoutMs}ms`);
				}
				throw new DingtalkStreamOpenError(error instanceof Error ? error.message : String(error));
			}
			if (!response.ok) {
				throw new DingtalkStreamOpenError(`HTTP ${response.status}`);
			}
			const body = (await response.json().catch(() => null)) as unknown;
			if (!isRecord(body) || typeof body.endpoint !== "string" || typeof body.ticket !== "string") {
				throw new DingtalkStreamOpenError("response missing endpoint or ticket");
			}
			return { endpoint: body.endpoint, ticket: body.ticket };
		},
	};
}

/**
 * Default socket factory wrapping the global `WebSocket`. Referenced lazily via `globalThis` (like
 * the Bun-native client factories) so importing this module never fails where `WebSocket` is absent;
 * the connector only invokes the factory when it actually connects. Binary frames are decoded to
 * UTF-8; the `error` and `close` events are collapsed into a single `onClose`.
 */
export function createDefaultDingtalkStreamSocketFactory(): DingtalkStreamSocketFactory {
	return (url, handlers) => {
		const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		if (!WebSocketCtor) {
			throw new DingtalkStreamOpenError("global WebSocket is not available in this runtime");
		}
		const socket = new WebSocketCtor(url);
		socket.binaryType = "arraybuffer";
		let closed = false;
		const fireClose = (error?: unknown): void => {
			if (closed) return;
			closed = true;
			handlers.onClose(error);
		};
		socket.addEventListener("open", () => handlers.onOpen());
		socket.addEventListener("message", (event: MessageEvent) => {
			const { data } = event;
			if (typeof data === "string") {
				handlers.onMessage(data);
			} else if (data instanceof ArrayBuffer) {
				handlers.onMessage(new TextDecoder().decode(data));
			}
		});
		socket.addEventListener("error", (event) => fireClose(event));
		socket.addEventListener("close", () => fireClose());
		return {
			send: (data: string) => socket.send(data),
			close: () => socket.close(),
		};
	};
}
