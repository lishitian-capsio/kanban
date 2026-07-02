// Bun-preferred display-width measurement with a Node fallback.
//
// The runtime is Bun-only, so in production this takes the Bun path:
// `Bun.stringWidth` is a native, SIMD-accelerated measurer whose defaults
// (`ambiguousIsNarrow: true`, `countAnsiEscapeCodes: false`) match the
// `string-width@8` behavior this replaces byte-for-byte — including ignoring
// embedded ANSI escapes, which matters because the CLI table renderer measures
// already-colorized header cells.
//
// The one environment without a `Bun` global is CI running the suite under Node
// `vitest` (`environment: "node"`), where it transparently falls back to the
// compact East-Asian-Width implementation below. The fallback was validated to
// return identical widths to both `Bun.stringWidth` and `string-width@8` across
// ASCII, CJK, kana, Hangul, emoji, combining marks and ANSI-prefixed strings.
//
// Mirrors the engine-detection + `__set…ForTest` convention in `src/fs/jsonl.ts`.

import { stripAnsi } from "./terminal/output-utils";

type StringWidthEngine = "bun" | "fallback";

let forcedEngine: StringWidthEngine | null = null;

/**
 * Test-only override so a single Bun process can exercise the Node fallback
 * (and vice versa). `null` restores auto-detect. Mirrors
 * `__setJsonlEngineForTest` in `fast-file.ts`/`jsonl.ts`.
 */
export function __setStringWidthEngineForTest(engine: StringWidthEngine | null): void {
	forcedEngine = engine;
}

interface BunStringWidth {
	stringWidth(input: string): number;
}

function bunStringWidth(): BunStringWidth | null {
	const bun = (globalThis as { Bun?: Partial<BunStringWidth> }).Bun;
	return typeof bun?.stringWidth === "function" ? (bun as BunStringWidth) : null;
}

/** Which engine is currently active (respects the test override). */
export function activeStringWidthEngine(): StringWidthEngine {
	if (forcedEngine !== null) {
		return forcedEngine;
	}
	return bunStringWidth() ? "bun" : "fallback";
}

function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … Kangxi
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compatibility
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
		(cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
		(cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility / Small forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) || // emoji (symbols & pictographs, emoticons)
		(cp >= 0x1f900 && cp <= 0x1f9ff) || // supplemental symbols & pictographs
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B and beyond
	);
}

function isZeroWidthCodePoint(cp: number): boolean {
	return (
		cp === 0 ||
		(cp >= 0x01 && cp <= 0x1f) || // C0 control chars
		(cp >= 0x7f && cp <= 0x9f) || // DEL + C1 control chars
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0x200b && cp <= 0x200f) || // zero-width space … directional marks
		cp === 0xfeff // zero-width no-break space / BOM
	);
}

function stringWidthFallback(input: string): number {
	let width = 0;
	// `for…of` iterates by code point, so astral characters (emoji) count once.
	for (const char of stripAnsi(input)) {
		const cp = char.codePointAt(0) ?? 0;
		if (isZeroWidthCodePoint(cp)) {
			continue;
		}
		width += isWideCodePoint(cp) ? 2 : 1;
	}
	return width;
}

/**
 * Display width of `input` in terminal columns, ignoring ANSI escape sequences.
 * Drop-in for `string-width@8` (`Bun.stringWidth` in production, the compact
 * fallback under Node/vitest).
 */
export function stringWidth(input: string): number {
	if (activeStringWidthEngine() === "bun") {
		const bun = bunStringWidth();
		if (bun) {
			return bun.stringWidth(input);
		}
	}
	return stringWidthFallback(input);
}
