/**
 * Generate a RFC 4122 v4 UUID that works in every runtime Kanban targets.
 *
 * `crypto.randomUUID()` is a Web Crypto API only exposed in *secure contexts*
 * (HTTPS, or http://localhost / 127.0.0.1). Kanban is frequently served over
 * plain HTTP from a LAN IP or through an SSH tunnel, where the browser leaves
 * `crypto.randomUUID` undefined and calling it throws
 * "crypto.randomUUID is not a function".
 *
 * We prefer the native implementation when available, then fall back to a
 * v4 built from `crypto.getRandomValues` — that API *is* available in
 * non-secure contexts (unlike `randomUUID`/`subtle`), so the fallback stays
 * cryptographically sound rather than degrading to `Math.random`.
 */
export function safeRandomUUID(): string {
	const native = globalThis.crypto?.randomUUID;
	if (typeof native === "function") {
		return native.call(globalThis.crypto);
	}
	return v4FromGetRandomValues();
}

/**
 * RFC 4122 v4 UUID derived from `crypto.getRandomValues` (available in
 * non-secure browser contexts). Sets the version (byte 6) and variant
 * (byte 8) bits, then formats the 16 bytes as canonical hex.
 */
function v4FromGetRandomValues(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	// Version 4 (0b0100 xxxx) and variant (0b10xx xxxx). `?? 0` keeps the
	// arithmetic definite under `noUncheckedIndexedAccess`; a Uint8Array read
	// is always a number at runtime.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	// `for…of` yields definite numbers, avoiding possibly-undefined indexing.
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
