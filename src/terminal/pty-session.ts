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
//   - string (Bun without a binary frame): Buffer.from copies into fresh owned memory.
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

// Map a POSIX signal name (Bun exposes the killing signal as `signalCode`) to
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
// processor. This rewrites a launch into a `cmd.exe /d /s /c "<command>"`
// invocation when needed, returning the full argv (executable followed by its
// arguments) to hand to `Bun.spawn`, or null when no wrapping applies
// (non-Windows, or a directly-spawnable .exe/.com).
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
// Bun native PTY backend
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

// ---------------------------------------------------------------------------
// PtySession
// ---------------------------------------------------------------------------

export class PtySession {
	private readonly bunProc: BunTerminalProcess;
	private interrupted = false;
	private exited = false;

	private constructor(
		proc: BunTerminalProcess,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		this.bunProc = proc;
		this.bunProc.exited.then((exitCode) => {
			this.exited = true;
			const signalCode = this.bunProc.signalCode;
			const signal = signalCode ? SIGNAL_NUMBERS[signalCode] : undefined;
			this.onExitCallback?.({ exitCode, signal });
		});
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

		// Bun's native Terminal API is the only PTY backend. The runtime ships on
		// Bun (`#!/usr/bin/env bun`); there is no node-pty fallback, so fail loudly
		// if the API is missing rather than silently spawning nothing.
		if (!checkBunTerminalAvailable()) {
			throw new Error(
				"Bun native Terminal API is unavailable — Kanban must run under Bun (bun >= 1.3.14) to spawn terminal/agent sessions.",
			);
		}

		const windowsArgv = resolveWindowsCmdArgv(binary, normalizedArgs, launchEnv);
		const spawnArgv = windowsArgv ?? [binary, ...normalizedArgs];
		const bunProc = (globalThis as { Bun: { spawn: Function } }).Bun.spawn(spawnArgv, {
			cwd,
			env: sanitizedEnv,
			terminal: {
				cols,
				rows,
				data(_terminal: unknown, data: string | Uint8Array) {
					onData?.(normalizeOutputChunk(data));
				},
			},
		}) as BunTerminalProcess;
		return new PtySession(bunProc, onExit);
	}

	get pid(): number {
		return this.bunProc.pid ?? -1;
	}

	write(data: string | Buffer): void {
		if (this.exited) {
			return;
		}
		try {
			this.bunProc.terminal.write(data);
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
		// Bun's Terminal API takes cell dimensions only; pixel dimensions (used by
		// node-pty for SIGWINCH ioctl) have no equivalent and are ignored.
		try {
			this.bunProc.terminal.resize(cols, rows);
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	pause(): void {
		// Bun Terminal has no flow-control pause equivalent — no-op.
	}

	resume(): void {
		// Bun Terminal has no flow-control resume equivalent — no-op.
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		const pid = this.bunProc.pid;
		this.bunProc.kill();
		if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
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
