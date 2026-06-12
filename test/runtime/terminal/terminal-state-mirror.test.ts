import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

const mirrors: TerminalStateMirror[] = [];

function createMirror(cols = 80, rows = 24): TerminalStateMirror {
	const mirror = new TerminalStateMirror(cols, rows);
	mirrors.push(mirror);
	return mirror;
}

afterEach(() => {
	while (mirrors.length > 0) {
		mirrors.pop()?.dispose();
	}
});

describe("TerminalStateMirror", () => {
	it("serializes inline terminal content and dimensions", async () => {
		const mirror = createMirror(100, 30);

		mirror.applyOutput(Buffer.from("hello\r\nworld", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(100);
		expect(snapshot.rows).toBe(30);
		expect(snapshot.snapshot).toContain("hello");
		expect(snapshot.snapshot).toContain("world");
	});

	it("preserves alternate-screen state when the active buffer is alternate", async () => {
		const mirror = createMirror();

		mirror.applyOutput(Buffer.from("\u001b[?1049h\u001b[Hfullscreen", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.snapshot).toContain("\u001b[?1049h");
		expect(snapshot.snapshot).toContain("fullscreen");
	});

	it("applies queued resizes before generating a snapshot", async () => {
		const mirror = createMirror(80, 24);

		mirror.applyOutput(Buffer.from("before resize", "utf8"));
		mirror.resize(120, 40);
		mirror.applyOutput(Buffer.from("\r\nafter resize", "utf8"));

		const snapshot = await mirror.getSnapshot();

		expect(snapshot.cols).toBe(120);
		expect(snapshot.rows).toBe(40);
		expect(snapshot.snapshot).toContain("after resize");
	});

	it("emits terminal query responses through the optional callback", async () => {
		const onInputResponse = vi.fn();
		const mirror = new TerminalStateMirror(80, 24, {
			onInputResponse,
		});
		mirrors.push(mirror);

		mirror.applyOutput(Buffer.from("\u001b[6n", "utf8"));
		await mirror.getSnapshot();

		expect(onInputResponse).toHaveBeenCalledWith("\u001b[1;1R");
	});

	// Regression: closing a CLI session (Ctrl+C / /exit) disposes the mirror while a
	// turn-boundary transcript capture may still be queued. That late getCommittedLines
	// call hit the xterm `Terminal.buffer` getter for the first time after dispose, which
	// lazily registers a disposable on an already-disposed DisposableStore and logged
	// "Trying to add a disposable to a DisposableStore that has already been disposed of".
	it("returns [] without warning when getCommittedLines is called after dispose", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const mirror = new TerminalStateMirror(80, 24);

			// Reproduce the race: the buffer getter is never touched before dispose, so the
			// first access happens post-dispose (as it does when capture loses the race).
			mirror.applyOutput(Buffer.from("line1\r\nline2\r\n", "utf8"));
			mirror.dispose();

			const lines = await mirror.getCommittedLines();

			expect(lines).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("tolerates a repeated dispose without throwing", () => {
		const mirror = new TerminalStateMirror(80, 24);
		mirror.dispose();
		expect(() => mirror.dispose()).not.toThrow();
	});
});
