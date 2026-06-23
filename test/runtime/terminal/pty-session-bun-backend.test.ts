import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These tests exercise the Bun native Terminal backend path of PtySession,
// which the shared vitest config normally disables via KANBAN_FORCE_NODE_PTY=1.
// We delete that flag and inject a fake `globalThis.Bun` so the backend selection
// resolves to Bun, then assert how the launch argv reaches `Bun.spawn` — in
// particular that Windows `.cmd`/`.bat` shims get the same cmd.exe wrapping the
// node-pty path applies.

const ptyMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node-pty", () => ({
	spawn: ptyMocks.spawn,
}));

import { PtySession } from "../../../src/terminal/pty-session";

interface FakeBunProc {
	pid: number;
	terminal: { write(): void; resize(): void; close(): void };
	kill(): void;
	exited: Promise<number>;
	signalCode: string | null;
}

type BunSpawnArgs = [argv: string[], options: unknown];

const originalPlatform = process.platform;
const originalForceNodePty = process.env.KANBAN_FORCE_NODE_PTY;
const originalComSpec = process.env.ComSpec;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

let bunSpawn: ReturnType<typeof vi.fn>;

function makeFakeBunProc(): FakeBunProc {
	return {
		pid: 9999,
		terminal: { write() {}, resize() {}, close() {} },
		kill() {},
		// Never resolves: keeps the session "running" so onExit isn't triggered.
		exited: new Promise<number>(() => {}),
		signalCode: null,
	};
}

function realBunSpawnCall(): BunSpawnArgs {
	// The availability probe spawns ["true"]; the real launch is the other call.
	const call = bunSpawn.mock.calls.find(
		(c): c is BunSpawnArgs => Array.isArray(c[0]) && c[0][0] !== "true",
	);
	if (!call) {
		throw new Error("Bun.spawn was not called with a real launch argv");
	}
	return call;
}

describe("PtySession Bun backend", () => {
	beforeEach(() => {
		ptyMocks.spawn.mockReset();
		delete process.env.KANBAN_FORCE_NODE_PTY;
		bunSpawn = vi.fn(() => makeFakeBunProc());
		(globalThis as unknown as { Bun?: { spawn: typeof bunSpawn } }).Bun = { spawn: bunSpawn };
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
	});

	afterEach(() => {
		setPlatform(originalPlatform);
		delete (globalThis as unknown as { Bun?: unknown }).Bun;
		if (originalForceNodePty === undefined) {
			delete process.env.KANBAN_FORCE_NODE_PTY;
		} else {
			process.env.KANBAN_FORCE_NODE_PTY = originalForceNodePty;
		}
		if (originalComSpec === undefined) {
			delete process.env.ComSpec;
		} else {
			process.env.ComSpec = originalComSpec;
		}
	});

	it("wraps a .cmd launch through cmd.exe on Windows under the Bun backend", () => {
		setPlatform("win32");

		const session = PtySession.spawn({
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
		expect(ptyMocks.spawn).not.toHaveBeenCalled();
		expect(session.pid).toBe(9999);
	});

	it("does not wrap a bare .exe launch on Windows under the Bun backend", () => {
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
		expect(ptyMocks.spawn).not.toHaveBeenCalled();
	});

	it("does not wrap launches outside Windows under the Bun backend", () => {
		setPlatform("darwin");

		PtySession.spawn({
			binary: "claude",
			args: ["--foo", "bar"],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});

		const [argv] = realBunSpawnCall();
		expect(argv).toEqual(["claude", "--foo", "bar"]);
		expect(ptyMocks.spawn).not.toHaveBeenCalled();
	});
});
