// A short, stable, human-referenceable code for an agent session.
//
// Unlike a board task's short id (`utils/task-id.ts`), which simply slices an
// already-short opaque id, an agent session is identified by a structured
// colon path (`__home_agent__:<workspaceId>:<agentId>:<threadId>`) whose head is
// identical across every session card in a workspace — slicing it would yield
// the same prefix for all of them. So we hash the *whole* session id into a
// compact fixed-length base36 code instead. The hash is a pure function of the
// session id, so the code is stable across refresh and list reordering and needs
// no new persisted field; distinct sessions in one workspace (which differ by
// agentId/threadId) hash to distinct codes with overwhelming probability.

/** Length of the rendered code, e.g. `K4F9A`. 36^5 ≈ 60M-code space. */
export const SESSION_SHORT_ID_LENGTH = 5;

const SESSION_SHORT_ID_SPACE = 36 ** SESSION_SHORT_ID_LENGTH;

// cyrb53: a fast, well-distributed 53-bit string hash (public domain). Two
// independent 32-bit lanes are mixed down to a 53-bit integer that fits in a JS
// safe integer — enough entropy that distinct session ids in a workspace map to
// distinct short codes.
function cyrb53(input: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < input.length; i += 1) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Derive the stable short code for a session from its full session id (the
 * synthetic home-agent-session id). Same id → same code, always.
 */
export function deriveSessionShortId(sessionId: string): string {
	const hash = cyrb53(sessionId.trim());
	return (hash % SESSION_SHORT_ID_SPACE).toString(36).toUpperCase().padStart(SESSION_SHORT_ID_LENGTH, "0");
}
