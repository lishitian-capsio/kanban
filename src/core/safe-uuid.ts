import { v4 as uuidV4 } from "uuid";

/**
 * Generate a RFC 4122 v4 UUID that works in every runtime Kanban targets.
 *
 * `crypto.randomUUID()` is a Web Crypto API only exposed in *secure contexts*
 * (HTTPS, or http://localhost / 127.0.0.1). Kanban is frequently served over
 * plain HTTP from a LAN IP or through an SSH tunnel, where the browser leaves
 * `crypto.randomUUID` undefined and calling it throws
 * "crypto.randomUUID is not a function".
 *
 * We prefer the native implementation when available, then fall back to the
 * `uuid` package, which derives entropy from `crypto.getRandomValues` — that
 * API *is* available in non-secure contexts (unlike `randomUUID`/`subtle`), so
 * the fallback stays cryptographically sound rather than degrading to
 * `Math.random`.
 */
export function safeRandomUUID(): string {
	const native = globalThis.crypto?.randomUUID;
	if (typeof native === "function") {
		return native.call(globalThis.crypto);
	}
	return uuidV4();
}
