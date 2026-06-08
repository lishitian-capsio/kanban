import * as pty from "node-pty";

import {
	buildWindowsCmdArgsCommandLine,
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

type PtyOutputChunk = string | Buffer | Uint8Array;

function normalizeOutputChunk(data: PtyOutputChunk): Buffer {
	if (typeof data === "string") {
		return Buffer.from(data, "utf8");
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function isIgnorablePtyWriteError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EIO" || code === "EBADF") {
		return true;
	}
	const msg = error.message.toLowerCase();
	return msg.includes("ebadf") || msg.includes("eio");
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

function terminatePtyProcess(ptyProcess: pty.IPty): void {
	const pid = ptyProcess.pid;
	ptyProcess.kill();
	if (process.platform !== "win32" && Number.isFinite(pid) && pid > 0) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Best effort: process group may already be gone or inaccessible.
		}
	}
}

// ---------------------------------------------------------------------------
// Bun native PTY backend
// ---------------------------------------------------------------------------

const isBunRuntime = typeof globalThis.Bun !== "undefined";

// When set, forces node-pty backend even under Bun (used in tests).
const forceNodePty = process.env.KANBAN_FORCE_NODE_PTY === "1";

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
	if (!isBunRuntime || forceNodePty) return false;
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
	private readonly nodePty?: pty.IPty;
	private readonly bunProc?: BunTerminalProcess;
	private interrupted = false;
	private exited = false;

	private constructor(
		backend: { kind: "node-pty"; pty: pty.IPty } | { kind: "bun"; proc: BunTerminalProcess },
		private readonly onDataCallback?: (chunk: Buffer) => void,
		private readonly onExitCallback?: (event: PtyExitEvent) => void,
	) {
		if (backend.kind === "node-pty") {
			this.nodePty = backend.pty;
			(this.nodePty.onData as unknown as (listener: (data: PtyOutputChunk) => void) => void)((data) => {
				const chunk = normalizeOutputChunk(data);
				this.onDataCallback?.(chunk);
			});
			this.nodePty.onExit((event) => {
				this.exited = true;
				this.onExitCallback?.(event);
			});
		} else {
			this.bunProc = backend.proc;
			this.bunProc.exited.then((exitCode) => {
				this.exited = true;
				const signalStr = this.bunProc?.signalCode;
				let signal: number | undefined;
				if (signalStr) {
					const sigMap: Record<string, number> = {
						SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4,
						SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
						SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
						SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
					};
					signal = sigMap[signalStr] ?? undefined;
				}
				this.onExitCallback?.({ exitCode, signal });
			});
		}
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

		// Prefer Bun's native Terminal API when available — node-pty's PTY
		// file-descriptor handling is incompatible with Bun's event loop and
		// causes child processes to receive SIGHUP immediately on spawn.
		if (checkBunTerminalAvailable()) {
			const bunProc = (globalThis as { Bun: { spawn: Function } }).Bun.spawn(
				[binary, ...normalizedArgs],
				{
					cwd,
					env: sanitizedEnv,
					terminal: {
						cols,
						rows,
						data(_terminal: unknown, data: string | Uint8Array) {
							const chunk = normalizeOutputChunk(data);
							onData?.(chunk);
						},
					},
				},
			) as BunTerminalProcess;
			return new PtySession({ kind: "bun", proc: bunProc }, onData, onExit);
		}

		// Node.js / node-pty path
		const terminalName = env?.TERM?.trim() || process.env.TERM?.trim() || "xterm-256color";
		const useWindowsShellLaunch = shouldUseWindowsCmdLaunch(binary, process.platform, launchEnv);
		const spawnBinary = useWindowsShellLaunch ? resolveWindowsComSpec(launchEnv) : binary;
		const spawnArgs = useWindowsShellLaunch ? buildWindowsCmdArgsCommandLine(binary, normalizedArgs) : normalizedArgs;
		const ptyOptions: pty.IPtyForkOptions = {
			name: terminalName,
			cwd,
			env: sanitizedEnv,
			cols,
			rows,
			encoding: null,
		};

		const ptyProcess = pty.spawn(spawnBinary, spawnArgs, ptyOptions);
		return new PtySession({ kind: "node-pty", pty: ptyProcess }, onData, onExit);
	}

	get pid(): number {
		return this.nodePty?.pid ?? this.bunProc?.pid ?? -1;
	}

	write(data: string | Buffer): void {
		try {
			if (this.nodePty) {
				this.nodePty.write(typeof data === "string" ? data : data.toString("utf8"));
			} else if (this.bunProc) {
				this.bunProc.terminal.write(typeof data === "string" ? data : data);
			}
		} catch (error) {
			if (isIgnorablePtyWriteError(error)) {
				return;
			}
			throw error;
		}
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		try {
			if (this.nodePty) {
				if (pixelWidth !== undefined && pixelHeight !== undefined) {
					this.nodePty.resize(cols, rows, {
						width: pixelWidth,
						height: pixelHeight,
					});
					return;
				}
				this.nodePty.resize(cols, rows);
			} else if (this.bunProc) {
				this.bunProc.terminal.resize(cols, rows);
			}
		} catch (error) {
			if (isIgnorablePtyResizeError(error)) {
				this.exited = true;
				return;
			}
			throw error;
		}
	}

	pause(): void {
		this.nodePty?.pause();
		// Bun Terminal has no pause equivalent — no-op.
	}

	resume(): void {
		this.nodePty?.resume();
		// Bun Terminal has no resume equivalent — no-op.
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		if (this.nodePty) {
			terminatePtyProcess(this.nodePty);
		} else if (this.bunProc) {
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
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}
}
