// Pure, side-effect-free helpers for provider model discovery (the "fetch
// available models" button in the add/edit provider dialog and the saved-provider
// /models lookup). Kept free of I/O so the URL building and error mapping can be
// unit-tested without a network, and so the dialog path and the service path share
// one source of truth for how a /models URL is assembled and how a failure is
// described to the user.

import type { RuntimeProviderProtocol } from "../../core/api-contract";

/**
 * Builds the model-discovery endpoint URL for a provider base URL + protocol.
 *
 * - OpenAI-compatible: `<base>/models` (the base usually already ends in `/v1`).
 * - Anthropic: `<base>/v1/models`, but if the base already carries the `/v1`
 *   version segment we avoid emitting `/v1/v1/models`.
 *
 * Trailing slashes on the base are normalized away first.
 */
export function buildModelsUrl(baseUrl: string, protocol: RuntimeProviderProtocol): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (protocol === "anthropic") {
		return /\/v1$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
	}
	return `${trimmed}/models`;
}

export interface ModelRecord {
	id: string;
	name?: string;
}

/**
 * Extracts `{ id, name? }` model records from a /models JSON payload. Tolerant of
 * the common container shapes (`data`, `models`, `result`, `items`) and of a
 * top-level array. Entries without a non-empty string `id` are dropped.
 */
export function extractModelRecords(payload: unknown): ModelRecord[] {
	const container =
		payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
	const list = Array.isArray(payload)
		? payload
		: container
			? ((container.data ?? container.models ?? container.result ?? container.items) as unknown)
			: undefined;
	if (!Array.isArray(list)) {
		return [];
	}
	const records: ModelRecord[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const entry = item as { id?: unknown; name?: unknown };
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (id.length === 0) {
			continue;
		}
		records.push({ id, name: typeof entry.name === "string" ? entry.name.trim() : undefined });
	}
	return records;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string") return code;
	}
	return "";
}

function errorName(error: unknown): string {
	if (error instanceof Error) return error.name;
	if (error && typeof error === "object" && "name" in error) {
		const name = (error as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return "";
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error ?? "");
}

export interface ClassifyModelFetchErrorArgs {
	url: string;
	/** The thrown network error, when the request never produced a response. */
	error?: unknown;
	/** HTTP status, when the request produced a non-OK response. */
	status?: number;
	statusText?: string;
}

/**
 * Maps a model-fetch failure to a clear, actionable message that distinguishes a
 * bad URL/port from a refused connection, a DNS miss, a timeout/proxy problem, a
 * TLS error, or an auth failure — instead of leaking the runtime's raw native
 * fetch error (e.g. Bun's "Unable to connect ... Was there a typo in the url or
 * port?"), which gives the user no way to tell these cases apart.
 */
export function classifyModelFetchError(args: ClassifyModelFetchErrorArgs): string {
	const { url, error, status, statusText } = args;
	const host = hostOf(url);

	if (typeof status === "number") {
		if (status === 401 || status === 403) {
			return `Authentication failed (HTTP ${status}) at ${url}. Check the API key.`;
		}
		if (status === 404) {
			return `Models endpoint not found (HTTP 404) at ${url}. Check the base URL and the selected protocol.`;
		}
		if (status === 429) {
			return `Rate limited (HTTP 429) by ${host}. Wait a moment and try again.`;
		}
		const suffix = statusText ? ` ${statusText}` : "";
		return `Failed to fetch models from ${url}: HTTP ${status}${suffix}.`;
	}

	const code = errorCode(error);
	const name = errorName(error);
	const message = errorMessage(error);
	const lower = message.toLowerCase();

	if (
		code === "ConnectionRefused" ||
		code === "ECONNREFUSED" ||
		lower.includes("connection refused") ||
		lower.includes("unable to connect") ||
		lower.includes("typo in the url")
	) {
		return `Connection refused at ${host}. Is the server running and is the host/port correct?`;
	}
	if (code === "ERR_INVALID_ARG_VALUE" || lower.includes("proxy url is invalid") || lower.includes("must be http")) {
		return `Invalid URL or proxy setting for ${url}: ${message}`;
	}
	if (
		code === "ENOTFOUND" ||
		code === "EAI_AGAIN" ||
		code === "DNSException" ||
		lower.includes("getaddrinfo") ||
		lower.includes("enotfound") ||
		lower.includes("failed to resolve") ||
		lower.includes("could not resolve")
	) {
		return `Could not resolve host "${host}". Check the URL for typos.`;
	}
	if (
		name === "TimeoutError" ||
		name === "AbortError" ||
		code === "ABORT_ERR" ||
		code === "UND_ERR_CONNECT_TIMEOUT" ||
		lower.includes("timed out") ||
		lower.includes("timeout")
	) {
		return `Request to ${url} timed out. The host may be unreachable or blocked by a proxy.`;
	}
	if (
		lower.includes("certificate") ||
		lower.includes("self-signed") ||
		lower.includes("self signed") ||
		lower.includes("ssl") ||
		lower.includes("tls") ||
		code === "CERT_HAS_EXPIRED" ||
		code === "DEPTH_ZERO_SELF_SIGNED_CERT"
	) {
		return `TLS/certificate error contacting ${host}: ${message}`;
	}
	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		lower.includes("socket connection was closed") ||
		lower.includes("econnreset")
	) {
		return `Connection to ${host} closed unexpectedly (possible network, TLS, or proxy issue).`;
	}
	return `Could not reach ${url}: ${message}`;
}
