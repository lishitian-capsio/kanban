import { afterEach, describe, expect, it, vi } from "vitest";

import { safeRandomUUID } from "./safe-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("safeRandomUUID", () => {
	it("uses the native crypto.randomUUID when available", () => {
		const native = vi.fn(() => "11111111-1111-4111-8111-111111111111");
		vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: native });

		expect(safeRandomUUID()).toBe("11111111-1111-4111-8111-111111111111");
		expect(native).toHaveBeenCalledTimes(1);
	});

	it("falls back to a v4 uuid when randomUUID is unavailable (non-secure context)", () => {
		// A non-secure context (plain HTTP + non-localhost) leaves crypto.randomUUID
		// undefined but still exposes crypto.getRandomValues, which the uuid package
		// uses for entropy. Delegate getRandomValues to the real implementation so it
		// stays correctly bound.
		const realCrypto = globalThis.crypto;
		vi.stubGlobal("crypto", {
			getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
			randomUUID: undefined,
		});

		const id = safeRandomUUID();
		expect(id).toMatch(UUID_V4);
		expect(id).not.toBe(safeRandomUUID());
	});
});
