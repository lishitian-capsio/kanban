/**
 * Partial masking for API key display.
 *
 * Keeps a few leading and trailing characters visible so a user can recognise
 * *which* key is set without exposing the secret, and replaces the middle with
 * dots. Very short keys are masked entirely so we never reveal almost the whole
 * key.
 *
 * Shared by the backend — which derives a non-secret preview from the stored
 * key (the full secret never leaves the runtime) — and the web-ui add/edit
 * provider dialog, which masks the value typed into the field. Both paths run
 * the same algorithm so the rendered mask is identical.
 */

/** Bullet character used to fill the masked middle of a key. */
export const API_KEY_MASK_DOT = "•";

/** Maximum number of characters revealed at each end of a long key. */
export const API_KEY_MASK_MAX_REVEAL_PER_SIDE = 4;

/**
 * Keys shorter than this are masked in full. Revealing a head and tail on a
 * very short key would leak most of it, so we degrade to a complete mask.
 */
export const API_KEY_MASK_MIN_LENGTH_FOR_PARTIAL = 9;

/**
 * Produce a display-safe partial mask of an API key.
 *
 * - Empty input → empty string (nothing to show).
 * - Short keys (< {@link API_KEY_MASK_MIN_LENGTH_FOR_PARTIAL}) → fully masked.
 * - Longer keys → up to {@link API_KEY_MASK_MAX_REVEAL_PER_SIDE} characters
 *   visible at each end (and never more than a quarter of the key per side, so
 *   shorter keys stay mostly masked), with the middle replaced by dots.
 *
 * @example maskApiKey("sk-abcdefghijklmnopqrstuvwxyz") // "sk-a••••••••••••••••••••wxyz"
 */
export function maskApiKey(value: string): string {
	const length = value.length;
	if (length === 0) {
		return "";
	}
	if (length < API_KEY_MASK_MIN_LENGTH_FOR_PARTIAL) {
		return API_KEY_MASK_DOT.repeat(length);
	}
	const reveal = Math.min(API_KEY_MASK_MAX_REVEAL_PER_SIDE, Math.floor(length / 4));
	const head = value.slice(0, reveal);
	const tail = value.slice(length - reveal);
	return `${head}${API_KEY_MASK_DOT.repeat(length - reveal * 2)}${tail}`;
}
