import { describe, expect, it } from "bun:test";

import { __setStringWidthEngineForTest, activeStringWidthEngine, stringWidth } from "../../src/cli-string-width";
import {
	__setStripAnsiEngineForTest,
	activeStripAnsiEngine,
	stripAnsi,
	stripAnsiAndControl,
} from "../../src/terminal/output-utils";

// Bun's runner is the only place `Bun.stringWidth` / `Bun.stripANSI` exist
// (vitest runs under Node). The Node fallbacks are exercised by the existing
// vitest suites (cli-human-render, claude/codex-workspace-trust); this file
// asserts the native Bun path is behaviorally equivalent to the fallback so the
// dual-engine wrappers can't silently drift.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(8);
const ST = `${ESC}\\`;

const STRIP_CASES: string[] = [
	`${ESC}[31mhello${ESC}[0m`,
	"plain text, no escapes",
	`${ESC}]8;;http://x${ST}link${ESC}]8;;${BEL}`, // OSC hyperlink (ST + BEL terminators)
	`back${BS}space`, // lone backspace must survive stripAnsi (applyBackspaces relies on it)
	`bell${BEL}here`,
	`${ESC}[1;32mgreen${ESC}[0m tab\tend`,
	"tab\ttab\nnewline\rcr",
	`${ESC}[200~paste${ESC}[201~`, // bracketed paste
	`${ESC}]11;rgb:1717/1717/2121${ST}`,
	`mid${NUL}null`,
	"中文字符" + `${ESC}[0m`,
	"do you trust the contents of this directory?",
];

const WIDTH_CASES: string[] = [
	"hello",
	"中文",
	`${ESC}[31mred${ESC}[0m`,
	"café",
	"a\tb",
	"😀",
	`${ESC}[1;36mHeader${ESC}[0m`,
	"日本語テスト",
	"ab…cd",
	"task-aaaa",
	"in_progress",
	"—",
	"{…}",
];

describe("stripAnsi / stripAnsiAndControl: Bun native == Node fallback", () => {
	it("runs under the Bun native engine", () => {
		__setStripAnsiEngineForTest(null);
		expect(activeStripAnsiEngine()).toBe("bun");
	});

	for (const input of STRIP_CASES) {
		it(`agrees for ${JSON.stringify(input)}`, () => {
			__setStripAnsiEngineForTest("bun");
			const bunStrip = stripAnsi(input);
			const bunStripControl = stripAnsiAndControl(input);
			__setStripAnsiEngineForTest("fallback");
			const fbStrip = stripAnsi(input);
			const fbStripControl = stripAnsiAndControl(input);
			__setStripAnsiEngineForTest(null);
			expect(bunStrip).toBe(fbStrip);
			expect(bunStripControl).toBe(fbStripControl);
		});
	}
});

describe("stringWidth: Bun native == Node fallback", () => {
	it("runs under the Bun native engine", () => {
		__setStringWidthEngineForTest(null);
		expect(activeStringWidthEngine()).toBe("bun");
	});

	for (const input of WIDTH_CASES) {
		it(`agrees for ${JSON.stringify(input)}`, () => {
			__setStringWidthEngineForTest("bun");
			const bunWidth = stringWidth(input);
			__setStringWidthEngineForTest("fallback");
			const fbWidth = stringWidth(input);
			__setStringWidthEngineForTest(null);
			expect(bunWidth).toBe(fbWidth);
		});
	}
});
