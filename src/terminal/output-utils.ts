// Bun-preferred ANSI stripping with a Node fallback.
//
// The runtime is Bun-only, so in production `stripAnsi` takes the native
// `Bun.stripANSI` path. Under CI running the suite with Node `vitest` (no `Bun`
// global) it transparently falls back to the hand-written state machine below,
// which is byte-for-byte the previous behavior. The two were validated to agree
// on CSI/OSC/bracketed-paste/ST-terminated sequences and — critically — both
// preserve a lone backspace (`terminal-transcript-capture` relies on this for
// `applyBackspaces`). They diverge only on the rare `ESC <intermediate>` string
// introducer (SOS/PM/APC), where `Bun.stripANSI` is the more correct of the two.
//
// Mirrors the engine-detection + `__set…ForTest` convention in `src/fs/jsonl.ts`.

type StripAnsiEngine = "bun" | "fallback";

let forcedEngine: StripAnsiEngine | null = null;

/**
 * Test-only override so a single Bun process can exercise the Node fallback (and
 * vice versa). `null` restores auto-detect.
 */
export function __setStripAnsiEngineForTest(engine: StripAnsiEngine | null): void {
	forcedEngine = engine;
}

interface BunStripAnsi {
	stripANSI(input: string): string;
}

function bunStripAnsi(): BunStripAnsi | null {
	const bun = (globalThis as { Bun?: Partial<BunStripAnsi> }).Bun;
	return typeof bun?.stripANSI === "function" ? (bun as BunStripAnsi) : null;
}

/** Which engine is currently active (respects the test override). */
export function activeStripAnsiEngine(): StripAnsiEngine {
	if (forcedEngine !== null) {
		return forcedEngine;
	}
	return bunStripAnsi() ? "bun" : "fallback";
}

function stripAnsiFallback(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === "\u001b") {
				mode = "escape";
				continue;
			}
			output += char;
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === "\u0007") {
				mode = "text";
			} else if (char === "\u001b") {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

/** Remove ANSI escape sequences from `input`, preserving other control chars. */
export function stripAnsi(input: string): string {
	if (activeStripAnsiEngine() === "bun") {
		const bun = bunStripAnsi();
		if (bun) {
			return bun.stripANSI(input);
		}
	}
	return stripAnsiFallback(input);
}

/**
 * Drop the C0/C1 control characters that survive ANSI stripping (BEL, NUL,
 * backspace, DEL, …) while keeping newline, carriage return and tab, which
 * downstream text normalization collapses as whitespace.
 */
export function stripControlChars(input: string): string {
	let output = "";
	for (const char of input) {
		const code = char.charCodeAt(0);
		if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
			output += char;
		}
	}
	return output;
}

/**
 * Remove ANSI escape sequences and leftover control characters — the terminal
 * text-cleaning step shared by the Claude/Codex workspace-trust prompt matchers.
 */
export function stripAnsiAndControl(input: string): string {
	return stripControlChars(stripAnsi(input));
}
