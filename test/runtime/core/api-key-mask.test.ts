import { describe, expect, it } from "vitest";
import {
	API_KEY_MASK_DOT,
	API_KEY_MASK_ELLIPSIS,
	API_KEY_MASK_MAX_REVEAL_PER_SIDE,
	API_KEY_MASK_MIN_LENGTH_FOR_PARTIAL,
	maskApiKey,
} from "../../../src/core/api-key-mask";

const dots = (count: number): string => API_KEY_MASK_DOT.repeat(count);

describe("maskApiKey", () => {
	it("returns an empty string for an empty key", () => {
		expect(maskApiKey("")).toBe("");
	});

	it("masks short keys entirely so head + tail can't leak most of the key", () => {
		// Below the partial-mask threshold every character is replaced with a dot.
		for (let length = 1; length < API_KEY_MASK_MIN_LENGTH_FOR_PARTIAL; length++) {
			const key = "a".repeat(length);
			expect(maskApiKey(key)).toBe(dots(length));
			expect(maskApiKey(key)).not.toContain("a");
		}
	});

	it("reveals head and tail for a long key with a single ellipsis in the middle", () => {
		const key = "sk-abcdefghijklmnopqrstuvwxyz"; // length 29
		const masked = maskApiKey(key);
		expect(masked.startsWith("sk-a")).toBe(true);
		expect(masked.endsWith("wxyz")).toBe(true);
		// The middle collapses to one ellipsis so the key's length isn't leaked.
		expect(masked).toBe(`sk-a${API_KEY_MASK_ELLIPSIS}wxyz`);
		expect(masked).toHaveLength(API_KEY_MASK_MAX_REVEAL_PER_SIDE * 2 + API_KEY_MASK_ELLIPSIS.length);
	});

	it("never reveals more than a quarter of the key per side for mid-length keys", () => {
		// length 9 → floor(9/4) = 2 revealed per side.
		expect(maskApiKey("123456789")).toBe(`12${API_KEY_MASK_ELLIPSIS}89`);
		// length 12 → floor(12/4) = 3 revealed per side.
		expect(maskApiKey("abcdefghijkl")).toBe(`abc${API_KEY_MASK_ELLIPSIS}jkl`);
	});

	it("caps revealed characters at the per-side maximum for very long keys", () => {
		const key = "x".repeat(100);
		const masked = maskApiKey(key);
		const revealed = masked.split(API_KEY_MASK_ELLIPSIS).join("");
		expect(revealed).toHaveLength(API_KEY_MASK_MAX_REVEAL_PER_SIDE * 2);
		// The mask stays compact regardless of how long the real key is.
		expect(masked).toHaveLength(API_KEY_MASK_MAX_REVEAL_PER_SIDE * 2 + API_KEY_MASK_ELLIPSIS.length);
	});
});
