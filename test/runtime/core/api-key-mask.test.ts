import { describe, expect, it } from "vitest";
import {
	API_KEY_MASK_DOT,
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

	it("reveals head and tail for a long key with dots in the middle", () => {
		const key = "sk-abcdefghijklmnopqrstuvwxyz"; // length 29
		const masked = maskApiKey(key);
		expect(masked.startsWith("sk-a")).toBe(true);
		expect(masked.endsWith("wxyz")).toBe(true);
		expect(masked).toBe(`sk-a${dots(key.length - API_KEY_MASK_MAX_REVEAL_PER_SIDE * 2)}wxyz`);
		// Same length as the input so the field still reads like a key.
		expect(masked).toHaveLength(key.length);
	});

	it("never reveals more than a quarter of the key per side for mid-length keys", () => {
		// length 9 → floor(9/4) = 2 revealed per side, 5 dots in the middle.
		expect(maskApiKey("123456789")).toBe(`12${dots(5)}89`);
		// length 12 → floor(12/4) = 3 revealed per side, 6 dots in the middle.
		expect(maskApiKey("abcdefghijkl")).toBe(`abc${dots(6)}jkl`);
	});

	it("caps revealed characters at the per-side maximum for very long keys", () => {
		const key = "x".repeat(100);
		const masked = maskApiKey(key);
		const revealed = masked.replace(new RegExp(API_KEY_MASK_DOT, "g"), "");
		expect(revealed).toHaveLength(API_KEY_MASK_MAX_REVEAL_PER_SIDE * 2);
	});
});
