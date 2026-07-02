import type { IExitEvent, IPty, IPtyForkOptions } from "bun-pty";
import {
	buildWindowsCmdArgsArray,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core/windows-cmd-launch";

export interface PtyExitEvent {
	exitCode: number;
	signal?: number;
}

export interface SpawnPtySessionRequest {
	binary: string;
	args?: string[] | string;
	cwd: string;
	env?: Record<string, string | undefined>;
	cols: number;
	rows: number;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: PtyExitEvent) => void;
}

// Ownership contract: this is the sole funnel turning raw terminal output into
// the `Buffer` handed to onData, and it guarantees that Buffer is *retainable* —
// its bytes are not mutated by the producer after the call, so a downstream
// consumer may hold the Buffer (or a subarray view of it) past the current tick.
// Two consumers rely on this: the protocol filter returns subarray views onto
// this Buffer, and the headless mirror retains those views until a deferred
// batched flush (see terminal-state-mirror.ts).
//   - string (Bun without a binary frame, and every bun-pty chunk): Buffer.from
//     copies into fresh owned memory.
//   - Uint8Array (Bun terminal): Buffer.from copies out of Bun's reused frame buffer.
function normalizeOutputChunk(data: string | Uint8Array): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.from(data);
}

function isIgnorablePtyWriteError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	// Prefer the machine-readable code over message matching. A write that races
	// the child's exit (terminal already torn down) surfaces as a benign
	// post-close I/O error.
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF" || code === "ERR_SOCKET_CLOSED") {
		return true;
	}
	const msg = error.message.toLowerCase();
	return msg.includes("ebadf") || msg.includes("eio") || msg.includes("socket is closed");
}

function isIgnorablePtyResizeError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF") {
		return true;
	}
	const msg = error.message.toLowerCase();
	return msg.includes("already exited") || msg.includes("ebadf") || msg.includes("eio");
}

// Map a POSIX signal name (both backends expose the killing signal as a name) to
// its numeric value, matching the `PtyExitEvent.signal` contract.
const SIGNAL_NUMBERS: Record<string, number> = {
	SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4,
	SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
	SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
	SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
};

// ---------------------------------------------------------------------------
// Windows .cmd/.bat launch wrapping
// ---------------------------------------------------------------------------

// Windows cannot directly spawn the `.cmd`/`.bat` shims npm installs for the CLI
// agents (claude/codex/droid/gemini/opencode); they must run through the command
// processor. This applies to BOTH Windows backends — bun-pty's ConPTY spawn uses
// CreateProcess, which has the same limitation as Bun's own spawn. This rewrites a
// launch into a `cmd.exe /d /s /c "<command>"` invocation when needed, returning
// the full argv (executable followed by its arguments) to hand to the backend, or
// null when no wrapping applies (non-Windows, or a directly-spawnable .exe/.com).
function resolveWindowsCmdArgv(
	binary: string,
	args: string[],
	launchEnv: NodeJS.ProcessEnv,
): string[] | null {
	if (!shouldUseWindowsCmdLaunch(binary, process.platform, launchEnv)) {
		return null;
	}
	return [resolveWindowsComSpec(launchEnv), ...buildWindowsCmdArgsArray(binary, args)];
}

// ---------------------------------------------------------------------------
// Backend abstraction
// ---------------------------------------------------------------------------

// The normalized process every backend produces. PtySession holds only this — it
// never touches a backend's native handle directly, so its write/resize/kill/exit
// logic is backend-agnostic.
interface NormalizedPtyProcess {
	readonly pid: number;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number): void;
	kill(signal?: number | string): void;
	onExit(callback: (event: PtyExitEvent) => void): void;
	// POSIX-only: whether stop() may additionally signal the child's process
	// group via `process.kill(-pid)`. Windows has no process groups.
	readonly supportsProcessGroupKill: boolean;
}

interface BackendSpawnInput {
	spawnArgv: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
	onData?: (chunk: Buffer) => void;
}

// ---------------------------------------------------------------------------
// Bun native PTY backend (POSIX)
// ---------------------------------------------------------------------------

function isBunRuntime(): boolean {
	return typeof globalThis.Bun !== "undefined";
}

interface BunTerminalProcess {
	pid: number;
	terminal: {
		write(data: string | Uint8Array): void;
		resize(cols: number, rows: number): void;
		close(): void;
	};
	kill(signal?: number | string): void;
	exited: Promise<number>;
	signalCode: string | null;
}

function isBunTerminalAvailable(): boolean {
	if (!isBunRuntime()) return false;
	try {
		const testProc = (globalThis as { Bun: { spawn: Function } }).Bun.spawn(["true"], {
			terminal: { cols: 1, rows: 1, data() {} },
		});
		const hasTerminal = typeof testProc?.terminal?.write === "function";
		testProc.kill();
		return hasTerminal;
	} catch {
		return false;
	}
}

// Lazily evaluate Bun terminal availability.
let _bunTerminalAvailable: boolean | null = null;
function checkBunTerminalAvailable(): boolean {
	if (_bunTerminalAvailable === null) {
		_bunTerminalAvailable = isBunTerminalAvailable();
	}
	return _bunTerminalAvailable;
}

function createBunTerminalProcess(input: BackendSpawnInput): NormalizedPtyProcess {
	const bunProc = (globalThis as { Bun: { spawn: Function } }).Bun.spawn(input.spawnArgv, {
		cwd: input.cwd,
		env: input.env,
		terminal: {
			cols: input.cols,
			rows: input.rows,
			data(_terminal: unknown, data: string | Uint8Array) {
				input.onData?.(normalizeOutputChunk(data));
			},
		},
	}) as BunTerminalProcess;

	return {
		get pid() {
			return bunProc.pid ?? -1;
		},
		write(data) {
			bunProc.terminal.write(data);
		},
		resize(cols, rows) {
			// Bun's Terminal API takes cell dimensions only; pixel dimensions (used
			// by node-pty for SIGWINCH ioctl) have no equivalent and are ignored.
			bunProc.terminal.resize(cols, rows);
		},
		kill(signal) {
			bunProc.kill(signal);
		},
		onExit(callback) {
			bunProc.exited.then((exitCode) => {
				const signalCode = bunProc.signalCode;
				callback({ exitCode, signal: signalCode ? SIGNAL_NUMBERS[signalCode] : undefined });
			});
		},
		supportsProcessGroupKill: process.platform !== "win32",
	};
}

// ---------------------------------------------------------------------------
// bun-pty backend (Windows / ConPTY)
// ---------------------------------------------------------------------------

// Bun's native Terminal API is POSIX-only (oven-sh/bun#25593). On Windows the PTY
// backend is `bun-pty` (Rust `portable-pty` → ConPTY, loaded via bun:ffi). It is
// an *optional* dependency that loads a prebuilt native library at import time, so
// it MUST NOT be imported on POSIX or under Node/CI. The module is loaded once at
// startup (preloadWindowsBackend) and cached here, keeping PtySession.spawn
// synchronous for all callers.
type BunPtyModule = {
	spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
};

let _windowsPtyModule: BunPtyModule | null = null;

/**
 * Test seam: synchronously inject (or clear) the Windows PTY backend module so
 * unit tests exercise the bun-pty path without loading the real native FFI
 * dependency (which is Bun-only and absent under `npx vitest` on Node/CI).
 */
export function __setWindowsPtyModuleForTest(module: BunPtyModule | null): void {
	_windowsPtyModule = module;
}

function isWindowsPtyBackendLoaded(): boolean {
	return _windowsPtyModule !== null;
}

function normalizeBunPtyExitEvent(event: IExitEvent): PtyExitEvent {
	const { exitCode, signal } = event;
	if (typeof signal === "number") {
		return { exitCode, signal };
	}
	if (typeof signal === "string") {
		return { exitCode, signal: SIGNAL_NUMBERS[signal] };
	}
	return { exitCode };
}

function createBunPtyProcess(input: BackendSpawnInput): NormalizedPtyProcess {
	const module = _windowsPtyModule;
	if (!module) {
		throw new Error(
			"bun-pty backend not loaded — call PtySession.preloadWindowsBackend() before spawning on Windows.",
		);
	}

	const [file, ...args] = input.spawnArgv;
	const pty = module.spawn(file, args, {
		name: "xterm-256color",
		cols: input.cols,
		rows: input.rows,
		cwd: input.cwd,
		env: input.env,
	});

	// bun-pty decodes output to UTF-8 strings before emitting; normalizeOutputChunk
	// copies into fresh owned memory, honoring the retainable-Buffer contract above.
	pty.onData((data: string) => {
		input.onData?.(normalizeOutputChunk(data));
	});

	return {
		get pid() {
			return pty.pid ?? -1;
		},
		write(data) {
			// bun-pty accepts strings only; terminal input is UTF-8 text.
			pty.write(typeof data === "string" ? data : data.toString("utf8"));
		},
		resize(cols, rows) {
			pty.resize(cols, rows);
		},
		kill(signal) {
			// bun-pty's kill takes a signal *name*; numeric signals (unused on the
			// stop() path, which passes none) fall back to its default (SIGTERM).
			pty.kill(typeof signal === "string" ? signal : undefined);
		},
		onExit(callback) {
			pty.onExit((event: IExitEvent) => callback(normalizeBunPtyExitEvent(event)));
		},
		supportsProcessGroupKill: false,
	};
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

function createBackendProcess(input: BackendSpawnInput): NormalizedPtyProcess {
	// On Windows, prefer the loaded bun-pty backend. It degrades to the Bun native
	// backend when bun-pty is not loaded (e.g. a future Bun with Windows Terminal
	// support, or unit tests that don't inject the fake module).
	if (process.platform === "win32" && isWindowsPtyBackendLoaded()) {
		return createBunPtyProcess(input);
	}
	if (checkBunTerminalAvailable()) {
		return createBunTerminalProcess(input);
	}
	if (process.platform === "win32") {
		throw new Error(
			"No PTY backend available on Windows — the `bun-pty` optional dependency failed to load. " +
				"Ensure `bun-pty` is installed (it ships the ConPTY native library) and Kanban runs under Bun.",
		);
	}
	throw new Error(
		"Bun native Terminal API is unavailable — Kanban must run under Bun (bun >= 1.3.14) to spawn terminal/agent sessions.",
	);
}

// ---------------------------------------------------------------------------
// PtySession
// ---------------------------------------------------------------------------

export class PtySession {
	private readonly proc: NormalizedPtyProcess;
	private interrupted = false;
	private exited = false;

	private constructor(
		proc: NormalizedPtyProcess,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		this.proc = proc;
		this.proc.onExit((event) => {
			this.exited = true;
			this.onExitCallback?.(event);
		});
	}

	/**
	 * Load the Windows PTY backend (`bun-pty`). No-op on POSIX and when already
	 * loaded. Call once during server startup on Windows so PtySession.spawn stays
	 * synchronous. This is the single deliberate dynamic import in the runtime: the
	 * `bun-pty` optional dependency loads a native FFI library at import time and
	 * must never be imported on POSIX or under Node/CI.
	 */
	static async preloadWindowsBackend(): Promise<void> {
		if (process.platform !== "win32") {
			return;
		}
		if (_windowsPtyModule) {
			return;
		}
		const module = await import("bun-pty");
		_windowsPtyModule = { spawn: module.spawn };
	}

	static spawn({ binary, args = [], cwd, env, cols, rows, onData, onExit }: SpawnPtySessionRequest): PtySession {
		const normalizedArgs = typeof args === "string" ? [args] : args;
		const launchEnv: NodeJS.ProcessEnv = env ? { ...process.env, ...env } : process.env;
		const sanitizedEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(launchEnv)) {
			if (value !== undefined) {
				sanitizedEnv[key] = value;
			}
		}

		const windowsArgv = resolveWindowsCmdArgv(binary, normalizedArgs, launchEnv);
		const spawnArgv = windowsArgv ?? [binary, ...normalizedArgs];
		const proc = createBackendProcess({
			spawnArgv,
			cwd,
			env: sanitizedEnv,
			cols,
			rows,
			onData,
		});
		return new PtySession(proc, onExit);
	}

	get pid(): number {
		return this.proc.pid;
	}

	write(data: string | Buffer): void {
		if (this.exited) {
			return;
		}
		try {
			this.proc.write(data);
		} catch (error) {
			if (isIgnorablePtyWriteError(error)) {
				return;
			}
			throw error;
		}
	}

	resize(cols: number, rows: number, _pixelWidth?: number, _pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		try {
			this.proc.resize(cols, rows);
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	pause(): void {
		// Neither backend has a flow-control pause equivalent — no-op.
	}

	resume(): void {
		// Neither backend has a flow-control resume equivalent — no-op.
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		const pid = this.proc.pid;
		this.proc.kill();
		if (this.proc.supportsProcessGroupKill && Number.isFinite(pid) && pid > 0) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// Best effort: process group may already be gone.
			}
		}
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}
}
