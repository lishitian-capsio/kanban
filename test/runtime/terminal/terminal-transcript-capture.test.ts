import { describe, expect, it } from "vitest";

import { TerminalTranscriptCapture } from "../../../src/terminal/terminal-transcript-capture";

describe("TerminalTranscriptCapture", () => {
	it("records the initial prompt as a user message", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		const message = capture.recordUserPrompt("Implement the feature");

		expect(message?.role).toBe("user");
		expect(message?.content).toBe("Implement the feature");
		expect(capture.listMessages()).toHaveLength(1);
	});

	it("ignores empty or whitespace-only prompts", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		expect(capture.recordUserPrompt("   ")).toBeNull();
		expect(capture.listMessages()).toHaveLength(0);
	});

	it("accumulates keystrokes and commits a user message on Enter", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		expect(capture.recordInput("hel")).toHaveLength(0);
		expect(capture.recordInput("lo")).toHaveLength(0);
		const committed = capture.recordInput("\r");

		expect(committed).toHaveLength(1);
		expect(committed[0]?.role).toBe("user");
		expect(committed[0]?.content).toBe("hello");
	});

	it("strips ANSI control sequences and bracketed-paste markers from input", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		// Arrow-key escape sequence then bracketed-paste wrapped text.
		const committed = capture.recordInput("[200~run tests[201~[Dx\r");

		expect(committed).toHaveLength(1);
		expect(committed[0]?.content).toBe("run testsx");
	});

	it("does not emit user messages for empty submissions", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		expect(capture.recordInput("\r")).toHaveLength(0);
		expect(capture.recordInput("   \r")).toHaveLength(0);
		expect(capture.listMessages()).toHaveLength(0);
	});

	it("captures newly scrolled-off lines as a single assistant message", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		const message = capture.captureCommittedLines(["I'll start by reading the file.", "Done."]);

		expect(message?.role).toBe("assistant");
		expect(message?.content).toBe("I'll start by reading the file.\nDone.");
	});

	it("emits each committed-line delta it is handed as its own assistant message", () => {
		// Delta tracking now lives in the mirror; the capture emits exactly what it is
		// handed each turn and performs no internal dedup of its own.
		const capture = new TerminalTranscriptCapture("task-1");

		const first = capture.captureCommittedLines(["line one", "line two"]);
		const second = capture.captureCommittedLines(["line three"]);

		expect(first?.content).toBe("line one\nline two");
		expect(second?.content).toBe("line three");
		expect(capture.listMessages()).toHaveLength(2);
	});

	it("returns null when handed no committed lines", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		expect(capture.captureCommittedLines([])).toBeNull();
		expect(capture.captureCommittedLines(["", "   "])).toBeNull();
		expect(capture.listMessages()).toHaveLength(0);
	});

	it("trims surrounding blank lines from assistant captures", () => {
		const capture = new TerminalTranscriptCapture("task-1");

		const message = capture.captureCommittedLines(["", "  ", "content", ""]);

		expect(message?.content).toBe("content");
	});

	it("drops the echoed user prompt from the following assistant capture", () => {
		const capture = new TerminalTranscriptCapture("task-1");
		capture.recordUserPrompt("run the build");

		const message = capture.captureCommittedLines(["run the build", "Build succeeded."]);

		expect(message?.content).toBe("Build succeeded.");
	});

	it("resetTurnBaseline discards half-typed input but keeps captured messages", () => {
		const capture = new TerminalTranscriptCapture("task-1");
		capture.captureCommittedLines(["first session output"]);

		// A half-typed line that never got an Enter, then a mirror restart.
		capture.recordInput("hal");
		capture.resetTurnBaseline();
		const committed = capture.recordInput("lo\r");

		// The discarded "hal" prefix is gone; only post-reset input is committed.
		expect(committed).toHaveLength(1);
		expect(committed[0]?.content).toBe("lo");
		expect(capture.listMessages()).toHaveLength(2);
	});
});
