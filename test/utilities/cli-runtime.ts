import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createGitTestEnv } from "./git-env";

export function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

/**
 * Resolve the Bun executable used to launch the Kanban runtime as a child
 * process. The runtime is Bun-only (it imports `bun:` modules at startup), so
 * the child must always run under Bun — never Node — regardless of what runs
 * the harness. Note vitest v4 executes test files in a Node worker pool even
 * when invoked via `bun vitest`, so `process.execPath` inside a test is
 * typically `node`; we therefore reuse the current binary only when this
 * process is genuinely Bun, and otherwise rely on `bun` being on PATH (CI
 * provisions it via oven-sh/setup-bun; dev has it on PATH).
 */
export function resolveBunExecutable(): string {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		return process.execPath;
	}
	return "bun";
}

/**
 * Build the executable + argv for launching the source CLI (`src/cli.ts`) as a
 * child process. Always launches under Bun (native TS, no tsx loader);
 * `--preload` wires the IPC shutdown hook when requested.
 */
export function buildSourceCliSpawn(
	args: string[],
	options: { withShutdownHook?: boolean } = {},
): { command: string; args: string[] } {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const preload = options.withShutdownHook ? ["--preload", resolveShutdownIpcHookPath()] : [];
	return { command: resolveBunExecutable(), args: [...preload, cliEntrypoint, ...args] };
}

export function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

export function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

export function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

export async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

export async function waitForServerStart(process: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

export async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

export async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

export function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
): ChildProcess {
	const { command, args: spawnArgs } = buildSourceCliSpawn(args);
	return spawn(command, spawnArgs, {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

export interface CliCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	didExit: boolean;
}

export async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<CliCommandResult> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 8_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

/**
 * Boot the Kanban runtime server from source (tsx) with the shutdown IPC hook
 * wired up, and resolve once it reports ready. Pair with {@link stopRuntimeServer}.
 */
export async function startRuntimeServer(options: {
	cwd: string;
	env: NodeJS.ProcessEnv;
	extraArgs?: string[];
}): Promise<ChildProcess> {
	const { command, args } = buildSourceCliSpawn(["--no-open", ...(options.extraArgs ?? [])], {
		withShutdownHook: true,
	});
	const serverProcess = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	await waitForServerStart(serverProcess);
	return serverProcess;
}

/** Gracefully stop a server started by {@link startRuntimeServer}, force-killing if it lingers. */
export async function stopRuntimeServer(serverProcess: ChildProcess): Promise<void> {
	await requestGracefulShutdown(serverProcess);
	const stopped = await waitForExit(serverProcess, 5_000);
	if (!stopped) {
		serverProcess.kill("SIGKILL");
		await waitForExit(serverProcess, 5_000);
	}
}
