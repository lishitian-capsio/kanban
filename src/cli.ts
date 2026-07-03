import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import ora, { type Ora } from "ora";
import packageJson from "../package.json" with { type: "json" };
import { printLine } from "./cli-output";
import { CLI_EXIT_USAGE_ERROR } from "./commands/cli-envelope";
import { registerSchemaCommand } from "./commands/cli-schema";
import { registerDbCommand } from "./commands/db";
import { registerFileCommand } from "./commands/file";
import { registerGiteeCommand } from "./commands/gitee";
import { registerGithubCommand } from "./commands/github";
import { registerHomeThreadCommand } from "./commands/home-thread";
import { registerHooksCommand } from "./commands/hooks";
import { registerPasscodeAliasCommand, registerRemoteCommand } from "./commands/remote";
import { registerServiceCommand } from "./commands/service";
import { registerStorageCommand } from "./commands/storage";
import { registerTaskCommand } from "./commands/task";
import { registerVaultCommand } from "./commands/vault";
import { buildSubprocessProxyEnv, installProxyFetch } from "./config/proxy-fetch";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config";
import type { RuntimeCommandRunResponse } from "./core/api-contract";
import {
	installGracefulShutdownHandlers,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "./core/graceful-shutdown";
import {
	buildKanbanRuntimeUrl,
	clearKanbanRuntimeTls,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeAccessUrls,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getRuntimeFetch,
	isKanbanRemoteHost,
	parseCliPortOption,
	type RuntimePortOption,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
	setKanbanRuntimeTls,
} from "./core/runtime-endpoint";
import { getGiteeAuthService } from "./gitee-auth";
import { getGitHubAuthService } from "./github-auth";
import { configureLogging, createLogger } from "./logging";
import { resolveAndPersistInternalToken } from "./security/internal-token-store";
import { disablePasscode, setInternalToken, setPasscode } from "./security/passcode-manager";
import { getPasscodeFilePath, isPersistedPasscodeDisabled, resolveAndPersistPasscode } from "./security/passcode-store";
import { startEventLoopStallWatchdog } from "./server/event-loop-stall-watchdog";
import { terminateProcessForTimeout } from "./server/process-termination";
import { startRuntimeOpsMetricsSampler } from "./server/runtime-ops-metrics";
import type { RuntimeStateHub } from "./server/runtime-state-hub";
import { isGitRepository } from "./state/git-repository-check";
import { captureNodeException, flushNodeTelemetry } from "./telemetry/sentry-node.js";
import { PtySession } from "./terminal/pty-session";
import type { TerminalSessionManager } from "./terminal/session-manager";
import { runOnDemandUpdate } from "./update/update";
import { registerGitCredentialInjector } from "./workspace/git-utils";

const cliLog = createLogger("cli");

interface CliOptions {
	noOpen: boolean;
	skipShutdownCleanup: boolean;
	host: string | null;
	port: RuntimePortOption | null;
	https: boolean;
	cert: string | null;
	key: string | null;
	noPasscode: boolean;
	/** Explicit passcode from `--passcode <value>` (overrides persisted/generated). */
	passcode: string | null;
}

const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

interface RootCommandOptions {
	host?: string;
	port?: RuntimePortOption;
	open?: boolean;
	skipShutdownCleanup?: boolean;
	update?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
	/** Commander stores `--no-passcode` as `false` and `--passcode <value>` as the string. */
	passcode?: boolean | string;
}

type ShutdownIndicatorResult = "done" | "interrupted" | "failed";

interface ShutdownIndicator {
	start: () => void;
	stop: (result?: ShutdownIndicatorResult) => void;
}

/**
 * Decide whether this CLI invocation should auto-open a browser tab.
 *
 * This uses a positive allowlist for app-launch shapes like `kanban`,
 * `kanban --host 0.0.0.0`, and `kanban --port 3484`. Any subcommand or
 * unexpected argument is treated as a command-style invocation instead.
 */
function shouldAutoOpenBrowserTabForInvocation(argv: string[]): boolean {
	// Program-level global flags (§6.1) are valid on the bare `serve` invocation too — they
	// must not flip this into "command-style" (which would make `run()` exit after parse and
	// kill the just-started server). `--json`/`--human`/`--quiet`/`--no-color` are inert for
	// serve but harmless; `--project-path` is ignored by serve (it uses cwd) but still a launch shape.
	const launchFlags = new Set([
		"--open",
		"--no-open",
		"--skip-shutdown-cleanup",
		"--https",
		"--no-passcode",
		"--json",
		"--human",
		"--no-color",
		"--quiet",
	]);
	const launchOptionsWithValues = new Set(["--host", "--port", "--cert", "--key", "--passcode", "--project-path"]);

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (!arg.startsWith("-")) {
			return false;
		}
		if (launchFlags.has(arg)) {
			continue;
		}
		const optionName = arg.split("=", 1)[0] ?? arg;
		if (!launchOptionsWithValues.has(optionName)) {
			return false;
		}
		if (arg.includes("=")) {
			continue;
		}
		const optionValue = argv[index + 1];
		if (!optionValue) {
			return false;
		}
		index += 1;
	}

	return true;
}

function createShutdownIndicator(stream: NodeJS.WriteStream = process.stderr): ShutdownIndicator {
	let spinner: Ora | null = null;
	let running = false;

	return {
		start() {
			if (running) {
				return;
			}
			running = true;
			if (!stream.isTTY) {
				stream.write("Cleaning up...\n");
				return;
			}
			spinner = ora({
				text: "Cleaning up...",
				stream,
			}).start();
		},
		stop(result = "done") {
			if (!running) {
				return;
			}
			running = false;
			if (spinner) {
				if (result === "done") {
					spinner.succeed("Cleaning up... done");
				} else if (result === "failed") {
					spinner.fail("Cleaning up... failed");
				} else {
					spinner.warn("Cleaning up... interrupted");
				}
				spinner = null;
				return;
			}

			const suffix = result === "done" ? "done" : result === "interrupted" ? "interrupted" : "failed";
			stream.write(`Cleanup ${suffix}.\n`);
		},
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const probe = createNetServer();
		probe.once("error", () => {
			resolve(false);
		});
		probe.listen(port, getKanbanRuntimeHost(), () => {
			probe.close(() => {
				resolve(true);
			});
		});
	});
}

async function findAvailableRuntimePort(startPort: number): Promise<number> {
	for (let candidate = startPort; candidate <= 65535; candidate += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
	}
	throw new Error("No available runtime port found.");
}

async function applyRuntimePortOption(portOption: CliOptions["port"]): Promise<number | null> {
	if (!portOption) {
		return null;
	}
	if (portOption.mode === "fixed") {
		setKanbanRuntimePort(portOption.value);
		return portOption.value;
	}
	const autoPort = await findAvailableRuntimePort(DEFAULT_KANBAN_RUNTIME_PORT);
	setKanbanRuntimePort(autoPort);
	return autoPort;
}

type TlsResult = { enabled: false } | { enabled: true };

async function resolveRuntimeTls(options: CliOptions): Promise<TlsResult> {
	const wantsHttps = options.https || options.cert !== null || options.key !== null;
	if (!wantsHttps) {
		clearKanbanRuntimeTls();
		return { enabled: false };
	}
	if (!options.cert || !options.key) {
		throw new Error("HTTPS requires both --cert and --key. Use plain HTTP if you do not have a TLS certificate.");
	}
	const cert = readFileSync(resolve(options.cert), "utf8");
	const key = readFileSync(resolve(options.key), "utf8");
	// Trust the exact configured cert for Kanban's own subcommands without
	// disabling certificate validation for unrelated HTTPS endpoints.
	setKanbanRuntimeTls({ cert, key, ca: cert });
	return { enabled: true };
}

async function assertPathIsDirectory(path: string): Promise<void> {
	const info = await stat(path);
	if (!info.isDirectory()) {
		throw new Error(`Project path is not a directory: ${path}`);
	}
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function isAddressInUseError(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "EADDRINUSE"
	);
}

async function canReachKanbanServer(workspaceId: string | null): Promise<boolean> {
	try {
		const headers: Record<string, string> = {};
		if (workspaceId) {
			headers["x-kanban-workspace-id"] = workspaceId;
		}
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(buildKanbanRuntimeUrl("/api/trpc/projects.list"), {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(1_500),
		});
		if (response.status === 404) {
			return false;
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: { data?: unknown };
			error?: unknown;
		} | null;
		return Boolean(payload && (payload.result || payload.error));
	} catch {
		return false;
	}
}

function getRuntimeAccessUrlsForServerUrl(serverUrl: string): string[] {
	try {
		const pathname = new URL(serverUrl).pathname;
		return getKanbanRuntimeAccessUrls(pathname === "/" ? undefined : pathname);
	} catch {
		return getKanbanRuntimeAccessUrls();
	}
}

function formatRuntimeAccessUrlList(urls: readonly string[]): string {
	return urls.map((url) => `   ${url}`).join("\n");
}

function printRuntimeAccessSummary(serverUrl: string): void {
	const accessUrls = getRuntimeAccessUrlsForServerUrl(serverUrl);
	if (isKanbanRemoteHost()) {
		printLine(`Available URLs:\n${formatRuntimeAccessUrlList(accessUrls)}`);
		return;
	}
	printLine("Network access: local only (127.0.0.1). Use `kanban --host 0.0.0.0` to listen on LAN.");
}

async function tryOpenExistingServer(options: { noOpen: boolean; shouldAutoOpenBrowser: boolean }): Promise<boolean> {
	let workspaceId: string | null = null;
	if (await isGitRepository(process.cwd())) {
		const { loadWorkspaceContext } = await import("./state/workspace-state.js");
		const context = await loadWorkspaceContext(process.cwd());
		workspaceId = context.workspaceId;
	}
	const running = await canReachKanbanServer(workspaceId);
	if (!running) {
		return false;
	}
	const projectUrl = workspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(workspaceId)}`)
		: getKanbanRuntimeOrigin();
	printLine(`Kanban already running at ${getKanbanRuntimeOrigin()}`);
	if (!options.noOpen && options.shouldAutoOpenBrowser) {
		try {
			const { openInBrowser } = await import("./server/browser.js");
			openInBrowser(projectUrl, {
				warn: (message) => {
					cliLog.warn(message);
				},
			});
		} catch (error) {
			cliLog.warn("Could not open browser automatically", { error });
		}
	}
	printLine(`Project URL: ${projectUrl}`);
	return true;
}

async function runScopedCommand(command: string, cwd: string): Promise<RuntimeCommandRunResponse> {
	const startedAt = Date.now();
	const outputLimitBytes = 64 * 1024;

	return await new Promise<RuntimeCommandRunResponse>((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			// process.env no longer carries proxy vars (they latch Bun's in-process
			// fetch); merge the configured proxy so shortcut commands keep routing
			// through it.
			env: { ...process.env, ...buildSubprocessProxyEnv() },
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (!child.stdout || !child.stderr) {
			reject(new Error("Shortcut process did not expose stdout/stderr."));
			return;
		}

		let stdout = "";
		let stderr = "";

		const appendOutput = (current: string, chunk: string): string => {
			const next = current + chunk;
			if (next.length <= outputLimitBytes) {
				return next;
			}
			return next.slice(0, outputLimitBytes);
		};

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout = appendOutput(stdout, String(chunk));
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr = appendOutput(stderr, String(chunk));
		});

		child.on("error", (error) => {
			reject(error);
		});

		const timeout = setTimeout(() => {
			terminateProcessForTimeout(child);
		}, 60_000);

		child.on("close", (code) => {
			clearTimeout(timeout);
			const exitCode = typeof code === "number" ? code : 1;
			const combinedOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
			resolve({
				exitCode,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
				combinedOutput,
				durationMs: Date.now() - startedAt,
			});
		});
	});
}

async function startServer(): Promise<{
	url: string;
	close: () => Promise<void>;
	shutdown: (options?: { skipSessionCleanup?: boolean }) => Promise<void>;
}> {
	// Install the live-proxy fetch interceptor before any provider SDK module is
	// loaded, so every in-process outbound request reads the current proxy holder
	// at call time (see config/proxy-fetch.ts). This also strips any inherited
	// proxy URL env so Bun latches "direct" and the holder stays authoritative;
	// the holder is seeded from config during workspace-registry init and updated
	// on every settings save.
	const strippedProxy = installProxyFetch();
	const proxyLog = createLogger("proxy-fetch");
	proxyLog.info("installed global fetch proxy interceptor");

	// Wire per-host HTTPS credential injection into the single `runGit` egress so every runtime
	// git network op (code push/pull, board push/fetch, clone, task worktree ops) authenticates
	// with the machine-local token for that host when logged in. Registered via the host-keyed
	// registry to keep `git-utils` a leaf module (the services transitively import it). Each is a
	// no-op until `kanban <host> login` has stored a token; the per-URL credential helpers
	// coexist cleanly so a repo with both github.com and gitee.com remotes authenticates each.
	registerGitCredentialInjector("github", () => getGitHubAuthService().getGitInjection());
	registerGitCredentialInjector("gitee", () => getGiteeAuthService().getGitInjection());

	// Load the Windows PTY backend (`bun-pty`, ConPTY) once, up front, so that
	// PtySession.spawn stays synchronous for terminal/agent sessions. No-op on
	// POSIX, where Bun's native Terminal API is the backend. A failure here is
	// non-fatal: spawn later throws a clear error rather than blocking startup.
	try {
		await PtySession.preloadWindowsBackend();
	} catch (error) {
		createLogger("pty-session").warn("failed to preload Windows PTY backend", { error });
	}

	// Start the event-loop stall watchdog before the server stack loads so a
	// synchronous hang anywhere in the runtime (e.g. the move-to-done freeze under
	// investigation) is observed from a second thread and attributed to the hot
	// path via breadcrumbs. Default-on; set KANBAN_STALL_WATCHDOG=0 to disable.
	const stallWatchdog =
		process.env.KANBAN_STALL_WATCHDOG === "0"
			? null
			: startEventLoopStallWatchdog(
					process.env.KANBAN_STALL_WATCHDOG_THRESHOLD_MS
						? { thresholdMs: Number(process.env.KANBAN_STALL_WATCHDOG_THRESHOLD_MS) }
						: undefined,
				);
	if (strippedProxy.https || strippedProxy.http) {
		proxyLog.info("cleared inherited proxy env; in-process routing now follows Kanban proxy settings", {
			clearedProxy: strippedProxy.https ?? strippedProxy.http,
		});
	}

	// Start the network bridge for CLI agent sessions. The bridge is a lightweight
	// forward proxy that CLI agents point their HTTP_PROXY at. It reads the
	// RuntimeProxyState holder on every request, so proxy config changes take
	// effect immediately without restarting sessions.
	const { startNetworkBridge, stopNetworkBridge } = await import("./unified-proxy/network-bridge.js");
	const networkBridge = startNetworkBridge();
	createLogger("network-bridge").info("started — CLI agent sessions will route through it", {
		url: networkBridge.url,
	});
	/*
		Server-only modules are loaded lazily because task-oriented subcommands like
		`kanban task create` and `kanban hooks ingest` do not need the runtime server.

		A regression in 25ba59f showed that eagerly importing the runtime stack here
		could leave the source CLI process alive after the command had already printed
		its JSON result. The issue first appeared after the native agent SDK runtime
		was added to the server import graph. We have not yet isolated the deepest
		handle creator inside that graph, so we keep command-style subcommands on the
		lightweight path and only load the server stack when we actually start Kanban.
	*/
	const [
		{ resolveProjectInputPath },
		{ pickDirectoryPathFromSystemDialog },
		{ createRuntimeServer },
		{ createRuntimeStateHub },
		{ resolveInteractiveShellCommand },
		{ shutdownRuntimeServer },
		{ collectProjectWorktreeTaskIdsForRemoval, createWorkspaceRegistry },
		{ clearPendingUpdateNotification, getPendingUpdateNotification },
	] = await Promise.all([
		import("./projects/project-path.js"),
		import("./server/directory-picker.js"),
		import("./server/runtime-server.js"),
		import("./server/runtime-state-hub.js"),
		import("./server/shell.js"),
		import("./server/shutdown-coordinator.js"),
		import("./server/workspace-registry.js"),
		import("./update/update.js"),
	]);
	let runtimeStateHub: RuntimeStateHub | undefined;
	const workspaceRegistry = await createWorkspaceRegistry({
		cwd: process.cwd(),
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		hasGitRepository: isGitRepository,
		pathIsDirectory,
		onTerminalManagerReady: (workspaceId, manager) => {
			runtimeStateHub?.trackTerminalManager(workspaceId, manager);
		},
	});
	runtimeStateHub = createRuntimeStateHub({
		workspaceRegistry,
	});
	const runtimeHub = runtimeStateHub;
	for (const { workspaceId, terminalManager } of workspaceRegistry.listManagedWorkspaces()) {
		runtimeHub.trackTerminalManager(workspaceId, terminalManager);
	}

	// Sample process RSS / CPU% and the stall watchdog's state on a modest
	// interval, broadcasting them as the low-frequency `runtime_metrics_updated`
	// channel that feeds the sidebar's VSCode-style ops status bar. The sampler's
	// timer is unref'd, so it never keeps the process alive on its own.
	const opsMetricsSampler = startRuntimeOpsMetricsSampler({
		onSample: (metrics) => runtimeHub.broadcastRuntimeOpsMetrics(metrics),
	});

	const disposeTrackedWorkspace = (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const disposed = workspaceRegistry.disposeWorkspace(workspaceId, {
			stopTerminalSessions: options?.stopTerminalSessions,
		});
		runtimeHub.disposeWorkspace(workspaceId);
		return disposed;
	};

	const runtimeServer = await createRuntimeServer({
		workspaceRegistry,
		runtimeStateHub: runtimeHub,
		warn: (message) => {
			cliLog.warn(message);
		},
		ensureTerminalManagerForWorkspace: workspaceRegistry.ensureTerminalManagerForWorkspace,
		resolveInteractiveShellCommand,
		runCommand: runScopedCommand,
		resolveProjectInputPath,
		assertPathIsDirectory,
		hasGitRepository: isGitRepository,
		disposeWorkspace: disposeTrackedWorkspace,
		collectProjectWorktreeTaskIdsForRemoval,
		pickDirectoryPathFromSystemDialog,
		getUpdateStatus: () => {
			const notification = getPendingUpdateNotification();
			if (!notification) {
				return {
					currentVersion: KANBAN_VERSION,
					latestVersion: null,
					updateAvailable: false,
					updateTiming: null,
					installCommand: null,
				};
			}
			return {
				currentVersion: notification.currentVersion,
				latestVersion: notification.latestVersion,
				updateAvailable: true,
				updateTiming: notification.updateTiming,
				installCommand: notification.installCommand,
			};
		},
		runUpdateNow: async () => {
			const result = await runOnDemandUpdate({
				currentVersion: KANBAN_VERSION,
			});
			if (
				result.status === "updated" ||
				result.status === "already_up_to_date" ||
				result.status === "cache_refreshed"
			) {
				// The pending notification is a one-shot signal recorded at startup.
				// Clearing it here prevents the modal from reappearing on page reload
				// after the user has already applied the update.
				clearPendingUpdateNotification();
			}
			return {
				status: result.status,
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
				message: result.message,
			};
		},
	});

	const close = async () => {
		await runtimeServer.close();
	};

	const shutdown = async (options?: { skipSessionCleanup?: boolean }) => {
		await shutdownRuntimeServer({
			workspaceRegistry,
			warn: (message) => {
				cliLog.warn(message);
			},
			closeRuntimeServer: close,
			skipSessionCleanup: options?.skipSessionCleanup ?? false,
		});
		opsMetricsSampler.stop();
		await stopNetworkBridge();
		await stallWatchdog?.stop();
	};

	return {
		url: runtimeServer.url,
		close,
		shutdown,
	};
}

async function startServerWithAutoPortRetry(options: CliOptions): Promise<Awaited<ReturnType<typeof startServer>>> {
	if (options.port?.mode !== "auto") {
		return await startServer();
	}

	while (true) {
		try {
			return await startServer();
		} catch (error) {
			if (!isAddressInUseError(error)) {
				throw error;
			}
			const currentPort = getKanbanRuntimePort();
			const retryPort = await findAvailableRuntimePort(currentPort + 1);
			setKanbanRuntimePort(retryPort);
			cliLog.warn("Runtime port became busy during startup, retrying", { currentPort, retryPort });
		}
	}
}

async function runMainCommand(options: CliOptions, shouldAutoOpenBrowser: boolean): Promise<void> {
	if (options.host) {
		setKanbanRuntimeHost(options.host);
		printLine(`Binding to host ${options.host}.`);
	}

	const [{ openInBrowser }, { autoUpdateOnStartup, runPendingAutoUpdateOnShutdown }] = await Promise.all([
		import("./server/browser.js"),
		import("./update/update.js"),
	]);

	const selectedPort = await applyRuntimePortOption(options.port);
	if (selectedPort !== null) {
		printLine(`Using runtime port ${selectedPort}.`);
	}

	const tlsResult = await resolveRuntimeTls(options);
	if (tlsResult.enabled) {
		printLine("HTTPS enabled.");
	}

	// Handle passcode generation for remote mode — deferred until after TLS
	// validation so that an invalid --cert/--key fails before a passcode is
	// printed (a passcode for a server that never starts is confusing).
	if (isKanbanRemoteHost()) {
		const explicit = options.passcode ?? process.env.KANBAN_PASSCODE?.trim() ?? null;
		// An explicit `--passcode`/`KANBAN_PASSCODE` always wins and re-enables auth, even over a
		// persisted disable; otherwise a persisted `remote passcode disable` keeps auth off.
		const persistedDisabled = !explicit && (await isPersistedPasscodeDisabled(getPasscodeFilePath()));
		if (options.noPasscode || persistedDisabled) {
			disablePasscode();
			const why = options.noPasscode ? "--no-passcode" : "persisted via `kanban remote passcode disable`";
			printLine(`Passcode authentication disabled (${why}). Ensure you have your own auth layer.`);
			printLine("   Re-enable later: `kanban remote passcode set <value>`");
		} else {
			// Resolve the effective passcode (explicit > persisted-reuse > generated) and
			// persist it so an OS-service restart no longer silently rotates it. The
			// passcode is printed ONLY here via printLine and never stored in logs.
			const { value, source } = await resolveAndPersistPasscode({ explicit });
			setPasscode(value);
			// Reuse the persisted internal token across restarts (parallels the
			// passcode) so an OS-service restart no longer rotates it and 401s the
			// hooks of still-running agent sessions / independently-launched CLIs.
			setInternalToken((await resolveAndPersistInternalToken()).value);
			const note =
				source === "persisted"
					? "reused from previous run"
					: source === "explicit"
						? "set from --passcode/KANBAN_PASSCODE"
						: "newly generated";
			const accessUrls = getKanbanRuntimeAccessUrls();
			printLine(
				`\n🔐 Remote access passcode: ${value}  (${note})\n   Access URLs:\n${formatRuntimeAccessUrlList(accessUrls)}\n\nShare these with users who need access.\n` +
					"   View later: `kanban remote passcode show` · status: `kanban remote status`\n",
			);
		}
	}

	autoUpdateOnStartup({
		currentVersion: KANBAN_VERSION,
	});

	let runtime: Awaited<ReturnType<typeof startServer>>;
	try {
		runtime = await startServerWithAutoPortRetry(options);
	} catch (error) {
		if (
			options.port?.mode !== "auto" &&
			isAddressInUseError(error) &&
			(await tryOpenExistingServer({ noOpen: options.noOpen, shouldAutoOpenBrowser }))
		) {
			return;
		}
		throw error;
	}
	printLine(`Kanban running at ${runtime.url}`);
	printRuntimeAccessSummary(runtime.url);
	if (!options.noOpen && shouldAutoOpenBrowser) {
		try {
			openInBrowser(runtime.url, {
				warn: (message) => {
					cliLog.warn(message);
				},
			});
		} catch (error) {
			cliLog.warn("Could not open browser automatically", { error });
		}
	}
	printLine("Press Ctrl+C to stop.");

	let isShuttingDown = false;
	const shutdownIndicator = createShutdownIndicator();
	const shutdown = async () => {
		if (isShuttingDown) {
			return;
		}
		isShuttingDown = true;
		runPendingAutoUpdateOnShutdown();
		if (options.skipShutdownCleanup) {
			cliLog.warn("Skipping shutdown task cleanup for this instance.");
		}
		await runtime.shutdown({
			skipSessionCleanup: options.skipShutdownCleanup,
		});
	};

	installGracefulShutdownHandlers({
		process,
		delayMs: 10000,
		exit: (code) => {
			process.exit(code);
		},
		reraiseSignal: (signal) => {
			process.kill(process.pid, signal);
		},
		onShutdown: async () => {
			shutdownIndicator.start();
			try {
				await shutdown();
				shutdownIndicator.stop("done");
			} catch (error) {
				shutdownIndicator.stop("failed");
				throw error;
			}
		},
		onShutdownError: (error) => {
			shutdownIndicator.stop("failed");
			captureNodeException(error, { area: "shutdown" });
			cliLog.error("Shutdown failed", { error });
		},
		onTimeout: (delayMs) => {
			shutdownIndicator.stop("interrupted");
			cliLog.error("Forced exit after shutdown timeout", { delayMs });
		},
		onSecondSignal: (signal) => {
			shutdownIndicator.stop("interrupted");
			cliLog.error("Forced exit on second signal", { signal });
		},
		suppressImmediateDuplicateSignals: shouldSuppressImmediateDuplicateShutdownSignals(),
	});
}

async function runUpdateCommand(): Promise<void> {
	const result = await runOnDemandUpdate({
		currentVersion: KANBAN_VERSION,
	});

	if (result.status === "updated" || result.status === "already_up_to_date" || result.status === "cache_refreshed") {
		printLine(result.message);
		return;
	}

	throw new Error(result.message);
}

function createProgram(invocationArgs: string[]): Command {
	const shouldAutoOpenBrowser = shouldAutoOpenBrowserTabForInvocation(invocationArgs);
	const program = new Command();
	program
		.name("kanban")
		.description("Local orchestration board for coding agents.")
		.version(KANBAN_VERSION, "-v, --version", "Output the version number")
		// Global flags (design doc §6.1), declared once at program level and read by
		// subcommand actions via `this.optsWithGlobals()`. `--project-path` replaces the
		// per-command boilerplate (I6); `--host`/`--port` share one parser with `service
		// install` (I7). Commander inherits these into every subcommand, so old invocations
		// like `kanban task list --project-path X` keep working unchanged (§8).
		.option("--project-path <path>", "Workspace to operate on. Defaults to the current directory workspace.")
		.option("--host <ip>", "Host IP to bind the server to (default: 127.0.0.1).")
		.option("--port <number|auto>", "Runtime port (1-65535) or auto.", parseCliPortOption)
		.option("--json", "Emit machine-readable JSON output (overrides KANBAN_OUTPUT and TTY detection).")
		.option("--human", "Force human-readable output even when piped (escape hatch for KANBAN_OUTPUT/auto).")
		.option("--no-color", "Disable ANSI color in human output (also honored via NO_COLOR).")
		.option("--quiet", "Suppress the human summary footer / spinners (no effect on --json).")
		.option("--no-open", "Do not open browser automatically.")
		.option("--skip-shutdown-cleanup", "Do not move sessions to done or delete task worktrees on shutdown.")
		.option("--https", "Enable HTTPS. Requires both --cert and --key.")
		.option("--cert <path>", "Path to a TLS certificate PEM file (implies HTTPS).")
		.option("--key <path>", "Path to a TLS private key PEM file (implies HTTPS).")
		.option("--update", "Update Kanban to the latest published version and exit.")
		// `--passcode <value>` and `--no-passcode` collapse into one commander field typed
		// `boolean | string` (I8): `--no-passcode` ⇒ `false`, `--passcode <value>` ⇒ the
		// string. Kept on `serve` (and `service install`) as a launch-time override; for the
		// persistent case prefer `kanban remote passcode set/disable` (P4) so these flags stay
		// rarely-needed (design doc §6.1).
		.option(
			"--passcode <value>",
			"Use a fixed remote-access passcode (persisted; overrides any saved/generated one). Also reads KANBAN_PASSCODE. For a persistent passcode prefer `kanban remote passcode set`.",
		)
		.option(
			"--no-passcode",
			"Disable auto-generated passcode for remote access (for advanced users behind a reverse proxy).",
		)
		.showHelpAfterError()
		// Usage/parse failures (unknown command, missing required arg) get exit code 2 (§6.2);
		// help/version are clean exits (exitCode 0). Commander still writes its human error to
		// stderr before throwing, so this only reclassifies the exit code (see `run()`).
		.exitOverride()
		.addHelpText("after", `\nRuntime URL: ${getKanbanRuntimeOrigin()}`);

	// The deprecated root `--agent <id>` flag (hidden+ignored since the P2 redesign) was
	// removed in P6 (design doc §8/§9) now that its compat window has elapsed.

	registerTaskCommand(program);
	registerFileCommand(program);
	registerVaultCommand(program);
	registerDbCommand(program);
	registerStorageCommand(program);
	registerHomeThreadCommand(program);
	registerHooksCommand(program);
	registerServiceCommand(program);
	registerRemoteCommand(program);
	registerPasscodeAliasCommand(program);
	registerGithubCommand(program);
	registerGiteeCommand(program);
	// Registered after the others so it sits alongside them in help; the manifest itself is
	// built at invocation time from the fully-assembled tree, so registration order is moot.
	registerSchemaCommand(program, { kanbanVersion: KANBAN_VERSION });

	program
		.command("update")
		.description("Update Kanban to the latest published version.")
		.action(async () => {
			await runUpdateCommand();
		});

	program.action(async (options: RootCommandOptions) => {
		if (options.update === true) {
			await runUpdateCommand();
			return;
		}
		await runMainCommand(
			{
				host: options.host ?? null,
				port: options.port ?? null,
				noOpen: options.open === false,
				skipShutdownCleanup: options.skipShutdownCleanup === true,
				https: options.https === true,
				cert: options.cert ?? null,
				key: options.key ?? null,
				noPasscode: options.passcode === false,
				passcode: typeof options.passcode === "string" ? options.passcode : null,
			},
			shouldAutoOpenBrowser,
		);
	});

	return program;
}

async function run(): Promise<void> {
	configureLogging();
	const argv = process.argv.slice(2);
	const program = createProgram(argv);
	try {
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		// `.exitOverride()` turns commander's process.exit into a throw so we can map the
		// exit code (§6.2): help/version are clean (exitCode 0); any other parse/usage
		// failure exits 2. Commander already wrote the human message to stderr.
		if (error instanceof CommanderError) {
			await flushNodeTelemetry();
			process.exit(error.exitCode === 0 ? 0 : CLI_EXIT_USAGE_ERROR);
		}
		throw error;
	}
	if (!shouldAutoOpenBrowserTabForInvocation(argv)) {
		await flushNodeTelemetry();
		process.exit(process.exitCode ?? 0);
	}
}

void run().catch(async (error) => {
	captureNodeException(error, { area: "startup" });
	await flushNodeTelemetry();
	cliLog.error("Failed to start Kanban", { error });
	process.exit(1);
});
