/**
 * macOS service manager backed by a **launchd LaunchAgent**.
 *
 * The plist lives at `~/Library/LaunchAgents/<label>.plist` and runs in the
 * user's login session. We drive it with `launchctl load -w` / `unload -w`
 * (the classic LaunchAgent pair): `-w` flips the disabled flag so the agent
 * truly starts/stops despite `KeepAlive`, without needing the GUI domain uid
 * that `bootstrap`/`bootout` require. stdout/stderr go to `~/.kanban/logs`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { spawnSyncRunner } from "../command-runner";
import type {
	CommandRunner,
	ServiceActionResult,
	ServiceConfig,
	ServiceManager,
	ServiceStatus,
} from "../service-types";
import { buildLaunchdLabel, buildLaunchdPlist } from "./launchd-plist";

interface MacosLaunchdManagerOptions {
	homeDir?: string;
	runner?: CommandRunner;
}

export class MacosLaunchdManager implements ServiceManager {
	readonly platform = "launchd";
	private readonly homeDir: string;
	private readonly runner: CommandRunner;

	constructor(options: MacosLaunchdManagerOptions = {}) {
		this.homeDir = options.homeDir ?? homedir();
		this.runner = options.runner ?? spawnSyncRunner;
	}

	private launchAgentsDir(): string {
		return join(this.homeDir, "Library", "LaunchAgents");
	}

	private plistPath(config: ServiceConfig): string {
		return join(this.launchAgentsDir(), `${buildLaunchdLabel(config.name)}.plist`);
	}

	private launchctl(...args: string[]) {
		return this.runner("launchctl", args);
	}

	/**
	 * Install is **idempotent**: re-running it with new `--host`/`--port` rewrites
	 * the plist AND `unload`s/`load`s the agent so the new `ProgramArguments` take
	 * effect (a bare second `load -w` is a no-op against an already-loaded agent,
	 * leaving it on the old command). The message honestly reflects first install
	 * vs reconfigure vs no-op — it never reports "Installed" when nothing changed.
	 */
	async install(config: ServiceConfig): Promise<ServiceActionResult> {
		const plistPath = this.plistPath(config);
		const label = buildLaunchdLabel(config.name);
		const nextPlist = buildLaunchdPlist(config);
		const previousPlist = existsSync(plistPath) ? await readFile(plistPath, "utf8") : null;
		const wasInstalled = previousPlist !== null;
		const hints = [`Logs: ${join(config.logDir, `${config.name}.out.log`)} / ${config.name}.err.log`];

		// Config unchanged: don't rewrite or bounce the agent.
		if (wasInstalled && previousPlist === nextPlist) {
			return {
				ok: true,
				message: `Agent "${label}" is already installed with this configuration (unchanged).`,
				artifactPath: plistPath,
				hints,
			};
		}

		await mkdir(this.launchAgentsDir(), { recursive: true });
		await mkdir(config.logDir, { recursive: true });
		// Unload the old definition before overwriting so the reload picks up the
		// new plist (launchd caches the loaded job; a second `load` alone no-ops).
		if (wasInstalled) {
			this.launchctl("unload", "-w", plistPath);
		}
		await writeFile(plistPath, nextPlist, "utf8");

		const load = this.launchctl("load", "-w", plistPath);
		if (load.code !== 0) {
			return { ok: false, message: `launchctl load failed: ${load.stderr.trim()}`, artifactPath: plistPath };
		}
		return {
			ok: true,
			message: wasInstalled
				? `Reconfigured and reloaded launchd agent "${label}".`
				: `Installed and started launchd agent "${label}".`,
			artifactPath: plistPath,
			hints,
		};
	}

	async uninstall(config: ServiceConfig): Promise<ServiceActionResult> {
		const plistPath = this.plistPath(config);
		if (existsSync(plistPath)) {
			this.launchctl("unload", "-w", plistPath);
			await rm(plistPath, { force: true });
		}
		return {
			ok: true,
			message: `Removed launchd agent "${buildLaunchdLabel(config.name)}".`,
			artifactPath: plistPath,
		};
	}

	async start(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.launchctl("load", "-w", this.plistPath(config));
			return result.code === 0
				? { ok: true, message: `Started "${config.name}".` }
				: { ok: false, message: `Failed to start "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async stop(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.launchctl("unload", "-w", this.plistPath(config));
			return result.code === 0
				? { ok: true, message: `Stopped "${config.name}".` }
				: { ok: false, message: `Failed to stop "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async restart(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			this.launchctl("unload", "-w", this.plistPath(config));
			const result = this.launchctl("load", "-w", this.plistPath(config));
			return result.code === 0
				? { ok: true, message: `Restarted "${config.name}".` }
				: { ok: false, message: `Failed to restart "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async status(config: ServiceConfig): Promise<ServiceStatus> {
		if (!existsSync(this.plistPath(config))) {
			return { installed: false, running: false, enabled: false };
		}
		const label = buildLaunchdLabel(config.name);
		const list = this.launchctl("list", label);
		if (list.code !== 0) {
			// plist exists but agent not loaded
			return { installed: true, running: false, enabled: false };
		}
		const pidMatch = list.stdout.match(/"PID"\s*=\s*(\d+)/);
		const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined;
		return {
			installed: true,
			running: pid !== undefined,
			enabled: true,
			pid,
			detail: pidMatch ? `PID ${pid}` : "loaded (not running)",
		};
	}

	private requireInstalled(config: ServiceConfig, action: () => ServiceActionResult): ServiceActionResult {
		if (!existsSync(this.plistPath(config))) {
			return {
				ok: false,
				message: `Service "${config.name}" is not installed. Run "kanban service install" first.`,
			};
		}
		return action();
	}
}
