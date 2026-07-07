/**
 * Shared, network-boundary HTTP helpers for the Lark adapter — the single place the outbound
 * provider, the tenant-token minter and the inbound connector go through to talk to Lark's OpenAPI.
 *
 * Extracted so the JSON-POST (`larkPostJson`) and binary-GET (`larkGetBinary`) plumbing — timeout,
 * status/business-code checking, {@link LarkApiError} shaping — lives in one place instead of being
 * duplicated per caller. Every function takes an injectable {@link LarkFetch}, so all callers stay
 * unit-testable against a fake transport with no real network. Nothing here logs request bodies or
 * auth headers.
 */
import { LarkApiError } from "./errors";

/** The minimal `fetch` surface the Lark adapter needs — satisfied by global `fetch` and test fakes. */
export type LarkFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Default per-request timeout for Lark OpenAPI calls. */
export const DEFAULT_LARK_REQUEST_TIMEOUT_MS = 15_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Options shared by the Lark HTTP helpers. */
export interface LarkRequestOptions {
	/** Extra request headers (e.g. `Authorization`). */
	headers?: Record<string, string>;
	/** Per-request timeout in ms. Defaults to {@link DEFAULT_LARK_REQUEST_TIMEOUT_MS}. */
	timeoutMs?: number;
}

function abortMessage(url: string, timeoutMs: number, error: unknown): string {
	if (error instanceof DOMException && error.name === "TimeoutError") {
		return `lark request to ${url} timed out after ${timeoutMs}ms`;
	}
	return `lark request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * POST a JSON body to a Lark endpoint and return the parsed JSON object. Throws {@link LarkApiError}
 * on a transport failure, a non-2xx HTTP status, a non-object body, or a non-zero business `code`.
 * Never logs the request body or the auth header.
 */
export async function larkPostJson(
	fetchImpl: LarkFetch,
	url: string,
	payload: Record<string, unknown>,
	options: LarkRequestOptions = {},
): Promise<Record<string, unknown>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LARK_REQUEST_TIMEOUT_MS;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8", ...options.headers },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new LarkApiError(abortMessage(url, timeoutMs, error), 0);
	}
	if (!response.ok) {
		throw new LarkApiError(`lark request failed with HTTP ${response.status}`, response.status);
	}
	const parsed = (await response.json().catch(() => null)) as unknown;
	if (!isRecord(parsed)) {
		throw new LarkApiError("lark returned a non-object response body", 0);
	}
	const code = typeof parsed.code === "number" ? parsed.code : 0;
	if (code !== 0) {
		const msg = typeof parsed.msg === "string" ? parsed.msg : "unknown error";
		throw new LarkApiError(`lark API error ${code}: ${msg}`, code);
	}
	return parsed;
}

/**
 * GET a JSON resource from a Lark endpoint and return the parsed JSON object. Throws
 * {@link LarkApiError} on a transport failure, a non-2xx HTTP status, a non-object body, or a
 * non-zero business `code`. Mirrors {@link larkPostJson} for read (`chats.get`, `users.get`, …).
 */
export async function larkGetJson(
	fetchImpl: LarkFetch,
	url: string,
	options: LarkRequestOptions = {},
): Promise<Record<string, unknown>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LARK_REQUEST_TIMEOUT_MS;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { ...options.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new LarkApiError(abortMessage(url, timeoutMs, error), 0);
	}
	if (!response.ok) {
		throw new LarkApiError(`lark request failed with HTTP ${response.status}`, response.status);
	}
	const parsed = (await response.json().catch(() => null)) as unknown;
	if (!isRecord(parsed)) {
		throw new LarkApiError("lark returned a non-object response body", 0);
	}
	const code = typeof parsed.code === "number" ? parsed.code : 0;
	if (code !== 0) {
		const msg = typeof parsed.msg === "string" ? parsed.msg : "unknown error";
		throw new LarkApiError(`lark API error ${code}: ${msg}`, code);
	}
	return parsed;
}

/** Binary payload returned by {@link larkGetBinary}. */
export interface LarkBinaryResponse {
	bytes: Uint8Array;
	/** The response `content-type` (parameters stripped), or `application/octet-stream` when absent. */
	mimeType: string;
}

/**
 * GET a binary resource (e.g. a message image) from a Lark endpoint. Lark returns the raw bytes on
 * success and a JSON `{ code, msg }` error body otherwise, so this throws {@link LarkApiError} on a
 * transport failure or non-2xx status (surfacing the business `code`/`msg` when the error body is
 * JSON). The URL is never logged with its token.
 */
export async function larkGetBinary(
	fetchImpl: LarkFetch,
	url: string,
	options: LarkRequestOptions = {},
): Promise<LarkBinaryResponse> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_LARK_REQUEST_TIMEOUT_MS;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { ...options.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new LarkApiError(abortMessage(url, timeoutMs, error), 0);
	}
	if (!response.ok) {
		const parsed = (await response.json().catch(() => null)) as unknown;
		if (isRecord(parsed) && typeof parsed.code === "number") {
			const msg = typeof parsed.msg === "string" ? parsed.msg : "unknown error";
			throw new LarkApiError(`lark API error ${parsed.code}: ${msg}`, parsed.code);
		}
		throw new LarkApiError(`lark request failed with HTTP ${response.status}`, response.status);
	}
	const buffer = await response.arrayBuffer();
	const contentType = response.headers.get("content-type");
	const mimeType = contentType ? contentType.split(";")[0].trim() : "application/octet-stream";
	return { bytes: new Uint8Array(buffer), mimeType: mimeType || "application/octet-stream" };
}
