import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// On Windows, PtySession uses the `bun-pty` backend (Rust portable-pty → ConPTY)
// instead of Bun's POSIX-only native Terminal API. These tests inject a fake
// bun-pty module via the test seam so the real native FFI dependency (Bun-only,
// absent under `npx vitest` on Node/CI) is never loaded, and assert how launches
// reach bun-pty's `spawn` and how the session delegates write/resize/kill/exit.

import { __setWindowsPtyModuleForTest, PtySession } from "../../../src/terminal/pty-session";

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number | string }) => void;

interface FakePty {
	pid: number;
	process: string;
	cols: number;
	rows: number;
	write: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	onData: (listener: DataListener) => { dispose: () => void };
	onExit: (listener: ExitListener) => { dispose: () => void };
	fireData: (data: string) => void;
	fireExit: (event: { exitCode: number; signal?: number | string }) => void;
}

type SpawnCall = [file: string, args: string[], options: Record<string, unknown>];

const originalPlatform = process.platform;
const originalBun = (globalThis as { Bun?: unknown }).Bun;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function makeFakePty(): FakePty {
	let dataListener: DataListener | undefined;
	let exitListener: ExitListener | undefined;
	return {
		pid: 7777,
		process: "claude",
		cols: 80,
		rows: 24,
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
		onData(listener) {
			dataListener = listener;
			return { dispose: () => {} };
		},
		onExit(listener) {
			exitListener = listener;
			return { dispose: () => {} };
		},
		fireData(data) {
			dataListener?.(data);
		},
		fireExit(event) {
			exitListener?.(event);
		},
	};
}

let spawnMock: ReturnType<typeof vi.fn>;
let lastPty: FakePty;

function spawnCall(): SpawnCall {
	const call = spawnMock.mock.calls[0];
	if (!call) {
		throw new Error("bun-pty spawn was not called");
	}
	return call as SpawnCall;
}

describe("PtySession bun-pty (Windows) backend", () => {
	beforeEach(() => {
		setPlatform("win32");
		lastPty = makeFakePty();
		spawnMock = vi.fn(() => lastPty);
		__setWindowsPtyModuleForTest({ spawn: spawnMock as never });
		// A fake Bun is present so any accidental fallback path is observable, but
		// the loaded bun-pty backend must take precedence on win32.
		(globalThis as unknown as { Bun: { spawn: () => unknown } }).Bun = {
			spawn: vi.fn(() => {
				throw new Error("Bun.spawn must not be used when bun-pty is loaded on win32");
			}),
		};
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
	});

	afterEach(() => {
		__setWindowsPtyModuleForTest(null);
		setPlatform(originalPlatform);
		if (originalBun === undefined) {
			delete (globalThis as { Bun?: unknown }).Bun;
		} else {
			(globalThis as { Bun?: unknown }).Bun = originalBun;
		}
	});

	// --- launch argv ---------------------------------------------------------

	it("wraps a .cmd launch through cmd.exe and splits argv into file + args", () => {
		PtySession.spawn({
			binary: "claude.cmd",
			args: ["--foo", "hello world"],
			cwd: "C:/repo",
			env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			cols: 120,
			rows: 40,
		});

		const [file, args, options] = spawnCall();
		expect(file).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(args[3]).toContain("claude.cmd");
		expect(args).toHaveLength(4);
		expect(options).toMatchObject({ name: "xterm-256color", cols: 120, rows: 40, cwd: "C:/repo" });
	});

	it("does not wrap a bare .exe launch", () => {
		PtySession.spawn({
			binary: "codex.exe",
			args: ["--foo", "bar"],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		const [file, args] = spawnCall();
		expect(file).toBe("codex.exe");
		expect(args).toEqual(["--foo", "bar"]);
	});

	it("passes a sanitized string env to bun-pty", () => {
		PtySession.spawn({
			binary: "codex.exe",
			cwd: "C:/repo",
			env: { KANBAN_TEST_VAR: "abc" },
			cols: 80,
			rows: 24,
		});

		const [, , options] = spawnCall();
		const env = options.env as Record<string, string>;
		expect(env.KANBAN_TEST_VAR).toBe("abc");
		for (const value of Object.values(env)) {
			expect(typeof value).toBe("string");
		}
	});

	// --- output --------------------------------------------------------------

	it("delivers decoded string output to onData as a UTF-8 Buffer", () => {
		const chunks: Buffer[] = [];
		PtySession.spawn({
			binary: "codex.exe",
			cwd: "C:/repo",
			cols: 80,
			rows: 24,
			onData: (chunk) => chunks.push(chunk),
		});

		lastPty.fireData("héllo");

		expect(chunks).toHaveLength(1);
		expect(Buffer.isBuffer(chunks[0])).toBe(true);
		expect(chunks[0]?.toString("utf8")).toBe("héllo");
	});

	// --- write ---------------------------------------------------------------

	it("forwards a string write to bun-pty", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		session.write("hello");
		expect(lastPty.write).toHaveBeenCalledWith("hello");
	});

	it("converts a Buffer write to a UTF-8 string for bun-pty", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		session.write(Buffer.from("hi", "utf8"));
		expect(lastPty.write).toHaveBeenCalledWith("hi");
	});

	it("ignores EIO write errors", () => {
		lastPty.write.mockImplementation(() => {
			const error = new Error("i/o error") as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		});
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		expect(() => session.write("hello")).not.toThrow();
	});

	it("does not write after the process has exited", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		lastPty.fireExit({ exitCode: 0 });
		session.write("hello");
		expect(lastPty.write).not.toHaveBeenCalled();
	});

	// --- resize --------------------------------------------------------------

	it("forwards resize (cell dimensions only)", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		session.resize(100, 30, 1200, 720);
		expect(lastPty.resize).toHaveBeenCalledWith(100, 30);
	});

	it("ignores resize after the process has exited", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		lastPty.fireExit({ exitCode: 0 });
		expect(() => session.resize(100, 30)).not.toThrow();
		expect(lastPty.resize).not.toHaveBeenCalled();
	});

	// --- exit ----------------------------------------------------------------

	it("maps a numeric exit signal straight through", () => {
		const events: Array<{ exitCode: number; signal?: number }> = [];
		PtySession.spawn({
			binary: "codex.exe",
			cwd: "C:/repo",
			cols: 80,
			rows: 24,
			onExit: (event) => events.push(event),
		});

		lastPty.fireExit({ exitCode: 143, signal: 15 });
		expect(events).toEqual([{ exitCode: 143, signal: 15 }]);
	});

	it("maps a named exit signal to its number", () => {
		const events: Array<{ exitCode: number; signal?: number }> = [];
		PtySession.spawn({
			binary: "codex.exe",
			cwd: "C:/repo",
			cols: 80,
			rows: 24,
			onExit: (event) => events.push(event),
		});

		lastPty.fireExit({ exitCode: 137, signal: "SIGKILL" });
		expect(events).toEqual([{ exitCode: 137, signal: 9 }]);
	});

	it("reports a clean exit with no signal", () => {
		const events: Array<{ exitCode: number; signal?: number }> = [];
		PtySession.spawn({
			binary: "codex.exe",
			cwd: "C:/repo",
			cols: 80,
			rows: 24,
			onExit: (event) => events.push(event),
		});

		lastPty.fireExit({ exitCode: 0 });
		expect(events).toEqual([{ exitCode: 0, signal: undefined }]);
	});

	// --- lifecycle -----------------------------------------------------------

	it("kills via bun-pty on stop without a process-group kill on Windows", () => {
		const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
		try {
			const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
			session.stop({ interrupted: true });
			expect(lastPty.kill).toHaveBeenCalled();
			expect(session.wasInterrupted()).toBe(true);
			// Windows has no process groups — no negative-pid signal.
			expect(processKill).not.toHaveBeenCalled();
		} finally {
			processKill.mockRestore();
		}
	});

	it("exposes the bun-pty pid", () => {
		const session = PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });
		expect(session.pid).toBe(7777);
	});

	// --- backend selection ---------------------------------------------------

	it("falls back to the Bun native backend when bun-pty is not loaded on win32", () => {
		__setWindowsPtyModuleForTest(null);
		const bunSpawn = vi.fn((argv: string[]) => {
			void argv;
			return {
				pid: 1,
				terminal: { write: vi.fn(), resize: vi.fn(), close: vi.fn() },
				kill: vi.fn(),
				exited: new Promise<number>(() => {}),
				signalCode: null,
			};
		});
		(globalThis as unknown as { Bun: { spawn: typeof bunSpawn } }).Bun = { spawn: bunSpawn };

		PtySession.spawn({ binary: "codex.exe", cwd: "C:/repo", cols: 80, rows: 24 });

		// The probe (["true"]) plus the real launch both go through Bun.spawn.
		expect(bunSpawn.mock.calls.some((c) => c[0]?.[0] === "codex.exe")).toBe(true);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
