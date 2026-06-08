/**
 * Shim for @oh-my-pi/pi-natives countTokens.
 *
 * The original pi-natives package uses Rust NAPI bindings for token counting.
 * This shim uses js-tiktoken to provide equivalent functionality.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
	if (!encoder) {
		encoder = getEncoding("o200k_base");
	}
	return encoder;
}

/**
 * Count the number of tokens in the given text or array of texts.
 * Uses the o200k_base encoding (GPT-4o family).
 */
export function countTokens(input: string | string[]): number {
	const enc = getEncoder();
	if (Array.isArray(input)) {
		return input.reduce((sum, text) => sum + enc.encode(text).length, 0);
	}
	return enc.encode(input).length;
}
