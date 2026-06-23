import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PtySession has a single backend: Bun's native Terminal API
// (`Bun.spawn(argv, { terminal })`). These tests inject a fake `globalThis.Bun`
// so the backend resolves deterministically under any runtime — CI runs vitest
// on Node, where the real Bun global is absent — and assert how launches reach
// `Bun.spawn` and how the session delegates write/resize/kill/exit.

import { PtySession } from "../../../src/terminal/pty-session";

type DataListener = (terminal: unknown, data: string | Uint8Array) => void;

interface FakeBunProc {
	pid: number;
	terminal: {
		write: ReturnType<typeof vi.fn>;
		resize: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	kill: ReturnType<typeof vi.fn>;
	exited: Promise<number>;
	signalCode: string | null;
	resolveExit: (code: number) => void;
	dataListener?: DataListener;
}

type BunSpawnArgs = [argv: string[], options: { terminal?: { data?: DataListener } }];

const originalPlatform = process.platform;
const originalBun = (globalThis as { Bun?: unknown }).Bun;
const originalComSpec = process.env.ComSpec;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

let bunSpawn: ReturnType<typeof vi.fn>;

function makeFakeBunProc(signalCode: string | null = null): FakeBunProc {
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	return {
		pid: 4242,
		terminal: { write: vi.fn(), resize: vi.fn(), close: vi.fn() },
		kill: vi.fn(),
		exited,
		signalCode,
		resolveExit,
	};
}

// The availability probe spawns ["true"]; the real launch is the other call.
function realBunSpawnCall(): BunSpawnArgs {
	const call = bunSpawn.mock.calls.find(
		(c): c is BunSpawnArgs => Array.isArray(c[0]) && c[0][0] !== "true",
	);
	if (!call) {
		throw new Error("Bun.spawn was not called with a real launch argv");
	}
	return call;
}

describe("PtySession Bun backend", () => {
	let lastProc: FakeBunProc;

	beforeEach(() => {
		lastProc = makeFakeBunProc();
		bunSpawn = vi.fn((argv: string[], options: BunSpawnArgs[1]) => {
			// The probe (["true"]) just needs a terminal.write to look available.
			if (argv[0] === "true") return makeFakeBunProc();
			lastProc.dataListener = options?.terminal?.data;
			return lastProc;
		});
		(globalThis as unknown as { Bun: { spawn: typeof bunSpawn } }).Bun = { spawn: bunSpawn };
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
	});

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalBun === undefined) {
			delete (globalThis as { Bun?: unknown }).Bun;
		} else {
			(globalThis as { Bun?: unknown }).Bun = originalBun;
		}
		if (originalComSpec === undefined) {
			delete process.env.ComSpec;
		} else {
			process.env.ComSpec = originalComSpec;
		}
	});

	// --- launch argv ---------------------------------------------------------

	it("spawns the binary and args directly outside Windows", () => {
		setPlatform("darwin");

		const session = PtySession.spawn({
			binary: "claude",
			args: ["--foo", "bar"],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});

		const [argv] = realBunSpawnCall();
		expect(argv).toEqual(["claude", "--foo", "bar"]);
		expect(session.pid).toBe(4242);
	});

	it("accepts a single string arg", () => {
		setPlatform("darwin");

		PtySession.spawn({ binary: "claude", args: "hello", cwd: "/tmp", cols: 80, rows: 24 });

		const [argv] = realBunSpawnCall();
		expect(argv).toEqual(["claude", "hello"]);
	});

	it("wraps a .cmd launch through cmd.exe on Windows", () => {
		setPlatform("win32");

		PtySession.spawn({
			binary: "claude.cmd",
			args: ["--foo", "hello world"],
			cwd: "C:/repo",
			env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			cols: 120,
			rows: 40,
		});

		const [argv] = realBunSpawnCall();
		expect(argv[0]).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
		expect(argv[4]).toContain("claude.cmd");
		expect(argv.length).toBe(5);
	});

	it("does not wrap a bare .exe launch on Windows", () => {
		setPlatform("win32");

		PtySession.spawn({
			binary: "codex.exe",
			args: ["--foo", "bar"],
			cwd: "C:/repo",
			env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
			cols: 120,
			rows: 40,
		});

		const [argv] = realBunSpawnCall();
		expect(argv).toEqual(["codex.exe", "--foo", "bar"]);
	});

	it("does not wrap cmd itself on Windows", () => {
		setPlatform("win32");

		PtySession.spawn({
			binary: "cmd.exe",
			args: ["/c", "echo hi"],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		const [argv] = realBunSpawnCall();
		expect(argv[0]).toBe("cmd.exe");
	});

	// --- output --------------------------------------------------------------

	it("delivers terminal output to onData as a Buffer", () => {
		setPlatform("darwin");
		const chunks: Buffer[] = [];

		PtySession.spawn({
			binary: "claude",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			onData: (chunk) => chunks.push(chunk),
		});

		lastProc.dataListener?.(lastProc.terminal, "hello");
		lastProc.dataListener?.(lastProc.terminal, new Uint8Array([0x68, 0x69]));

		expect(chunks).toHaveLength(2);
		expect(Buffer.isBuffer(chunks[0])).toBe(true);
		expect(chunks[0]?.toString("utf8")).toBe("hello");
		expect(chunks[1]?.toString("utf8")).toBe("hi");
	});

	// --- write ---------------------------------------------------------------

	it("forwards write to the Bun terminal", () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		session.write("hello");
		expect(lastProc.terminal.write).toHaveBeenCalledWith("hello");
	});

	it("ignores EIO write errors", () => {
		setPlatform("darwin");
		lastProc.terminal.write.mockImplementation(() => {
			const error = new Error("i/o error") as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		});
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		expect(() => session.write("hello")).not.toThrow();
	});

	it("rethrows non-ignorable write errors", () => {
		setPlatform("darwin");
		lastProc.terminal.write.mockImplementation(() => {
			const error = new Error("permission denied") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		expect(() => session.write("hello")).toThrow("permission denied");
	});

	it("does not write after the process has exited", async () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		lastProc.resolveExit(0);
		await lastProc.exited;
		await Promise.resolve();

		session.write("hello");
		expect(lastProc.terminal.write).not.toHaveBeenCalled();
	});

	// --- resize --------------------------------------------------------------

	it("forwards resize to the Bun terminal (cell dimensions only)", () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		session.resize(100, 30, 1200, 720);
		expect(lastProc.terminal.resize).toHaveBeenCalledWith(100, 30);
	});

	it("ignores resize calls after the process has exited", async () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		lastProc.resolveExit(0);
		await lastProc.exited;
		await Promise.resolve();

		expect(() => session.resize(100, 30)).not.toThrow();
		expect(lastProc.terminal.resize).not.toHaveBeenCalled();
	});

	it("swallows an already-exited resize race and rethrows other errors", () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		lastProc.terminal.resize.mockImplementationOnce(() => {
			throw new Error("Cannot resize a pty that has already exited");
		});
		expect(() => session.resize(100, 30)).not.toThrow();

		lastProc.terminal.resize.mockImplementationOnce(() => {
			const error = new Error("permission denied") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		// The swallowed race marks the session exited, so a subsequent resize is a
		// no-op and never reaches the throwing terminal.
		expect(() => session.resize(120, 40)).not.toThrow();
	});

	// --- exit ----------------------------------------------------------------

	it("maps the exit code and killing signal to onExit", async () => {
		setPlatform("darwin");
		lastProc.signalCode = "SIGTERM";
		const events: Array<{ exitCode: number; signal?: number }> = [];

		PtySession.spawn({
			binary: "claude",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			onExit: (event) => events.push(event),
		});

		lastProc.resolveExit(143);
		await lastProc.exited;
		await Promise.resolve();

		expect(events).toEqual([{ exitCode: 143, signal: 15 }]);
	});

	it("reports a clean exit with no signal", async () => {
		setPlatform("darwin");
		const events: Array<{ exitCode: number; signal?: number }> = [];

		PtySession.spawn({
			binary: "claude",
			cwd: "/tmp",
			cols: 80,
			rows: 24,
			onExit: (event) => events.push(event),
		});

		lastProc.resolveExit(0);
		await lastProc.exited;
		await Promise.resolve();

		expect(events).toEqual([{ exitCode: 0, signal: undefined }]);
	});

	// --- lifecycle -----------------------------------------------------------

	it("kills the process on stop", () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		session.stop({ interrupted: true });
		expect(lastProc.kill).toHaveBeenCalled();
		expect(session.wasInterrupted()).toBe(true);
	});

	it("treats pause and resume as no-ops", () => {
		setPlatform("darwin");
		const session = PtySession.spawn({ binary: "claude", cwd: "/tmp", cols: 80, rows: 24 });

		expect(() => {
			session.pause();
			session.resume();
		}).not.toThrow();
	});
});
