/**
 * Shared types for the OS-level background service (`kanban service ...`).
 *
 * A {@link ServiceConfig} is the platform-agnostic description of the runtime
 * we want to register as a daemon/agent/scheduled-task. Each platform
 * {@link ServiceManager} turns it into the native artifact (systemd unit,
 * launchd plist, Windows scheduled task) and drives its lifecycle.
 */

/** Default service / unit / task name when the user does not pass `--name`. */
export const DEFAULT_SERVICE_NAME = "kanban";

/** Platform-agnostic description of the Kanban runtime to run as a service. */
export interface ServiceConfig {
	/** Service / systemd unit / launchd label suffix / scheduled-task name. */
	name: string;
	/** Absolute path to the `bun` executable that runs the runtime. */
	bunPath: string;
	/** Absolute path to the Kanban CLI entry point (`dist/cli.js`). */
	scriptPath: string;
	/** Working directory the runtime is launched from (the project repo). */
	workingDir: string;
	/** Directory where the service writes stdout/stderr logs. */
	logDir: string;
	/** Bind host. Omitted ⇒ runtime default (127.0.0.1). */
	host?: string;
	/** Bind port. Omitted ⇒ runtime default. */
	port?: number;
	/**
	 * Whether the auto-generated remote-access passcode stays enabled.
	 * `false` ⇒ the service launches with `--no-passcode`.
	 */
	passcode: boolean;
	/** Extra runtime args appended verbatim (e.g. `--https --cert ...`). */
	extraArgs?: string[];
}

/** Result of a single native command invocation (no shell). */
export interface CommandResult {
	/** Process exit code (`null` ⇒ killed by signal / failed to spawn). */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Injectable command runner so managers can be unit-tested without spawning
 * real processes. The default implementation wraps `child_process.spawnSync`.
 */
export type CommandRunner = (command: string, args: string[]) => CommandResult;

/** Lifecycle status of an installed service. */
export interface ServiceStatus {
	/** The native artifact (unit/plist/task) exists. */
	installed: boolean;
	/** The service process is currently running. */
	running: boolean;
	/** The service is set to start automatically at login/boot. */
	enabled: boolean;
	/** Process id when known and running. */
	pid?: number;
	/** Human-readable detail (raw native status excerpt). */
	detail?: string;
}

/** Outcome of an install/uninstall/start/stop/restart action. */
export interface ServiceActionResult {
	ok: boolean;
	/** Human-readable message describing what happened. */
	message: string;
	/** Path to the generated native artifact, when relevant. */
	artifactPath?: string;
	/** Extra platform-specific hints for the user (e.g. enable-linger). */
	hints?: string[];
}

/** Platform implementation that installs and controls the service. */
export interface ServiceManager {
	/** Short platform label for diagnostics/JSON output, e.g. `"systemd"`. */
	readonly platform: string;
	install(config: ServiceConfig): Promise<ServiceActionResult>;
	uninstall(config: ServiceConfig): Promise<ServiceActionResult>;
	start(config: ServiceConfig): Promise<ServiceActionResult>;
	stop(config: ServiceConfig): Promise<ServiceActionResult>;
	restart(config: ServiceConfig): Promise<ServiceActionResult>;
	status(config: ServiceConfig): Promise<ServiceStatus>;
}
