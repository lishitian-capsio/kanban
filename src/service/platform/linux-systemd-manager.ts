/**
 * Linux service manager backed by **systemd user services**.
 *
 * Everything runs under `systemctl --user`, so no root is required. The unit
 * file lives at `~/.config/systemd/user/<name>.service`; logs go to journald
 * (`journalctl --user -u <name>`). Persisting across logout / starting at boot
 * needs `loginctl enable-linger`, which we surface as a hint (it may itself
 * require privileges, so we don't run it automatically).
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
import { buildSystemdUnit } from "./systemd-unit";

interface LinuxSystemdManagerOptions {
	homeDir?: string;
	runner?: CommandRunner;
}

export class LinuxSystemdManager implements ServiceManager {
	readonly platform = "systemd";
	private readonly homeDir: string;
	private readonly runner: CommandRunner;

	constructor(options: LinuxSystemdManagerOptions = {}) {
		this.homeDir = options.homeDir ?? homedir();
		this.runner = options.runner ?? spawnSyncRunner;
	}

	private unitDir(): string {
		return join(this.homeDir, ".config", "systemd", "user");
	}

	private unitFileName(name: string): string {
		return `${name}.service`;
	}

	private unitPath(name: string): string {
		return join(this.unitDir(), this.unitFileName(name));
	}

	private systemctl(...args: string[]) {
		return this.runner("systemctl", ["--user", ...args]);
	}

	/**
	 * Install is **idempotent**: re-running it with new `--host`/`--port` rewrites
	 * the unit AND `restart`s the running daemon so the new `ExecStart` actually
	 * takes effect (a bare `enable --now` would leave a running unit on the old
	 * command). The returned message honestly reflects whether this was a first
	 * install, a reconfigure, or a no-op (config unchanged) — it never reports
	 * "Installed" when nothing was applied.
	 */
	async install(config: ServiceConfig): Promise<ServiceActionResult> {
		const unitPath = this.unitPath(config.name);
		const unitFile = this.unitFileName(config.name);
		const nextUnit = buildSystemdUnit(config);
		const previousUnit = existsSync(unitPath) ? await readFile(unitPath, "utf8") : null;
		const wasInstalled = previousUnit !== null;
		const hints = [
			`Run "loginctl enable-linger ${this.currentUser()}" to keep the service running at boot and after logout.`,
			`View logs with "journalctl --user -u ${config.name} -f".`,
		];

		// Config unchanged: don't rewrite or bounce the daemon — just make sure it
		// is enabled and running, and say so truthfully.
		if (wasInstalled && previousUnit === nextUnit) {
			const enable = this.systemctl("enable", "--now", unitFile);
			if (enable.code !== 0) {
				return {
					ok: false,
					message: `systemctl enable --now failed: ${enable.stderr.trim()}`,
					artifactPath: unitPath,
				};
			}
			return {
				ok: true,
				message: `Service "${config.name}" is already installed with this configuration (unchanged); left enabled and running.`,
				artifactPath: unitPath,
				hints,
			};
		}

		await mkdir(this.unitDir(), { recursive: true });
		await writeFile(unitPath, nextUnit, "utf8");

		const reload = this.systemctl("daemon-reload");
		if (reload.code !== 0) {
			return {
				ok: false,
				message: `systemctl daemon-reload failed: ${reload.stderr.trim()}`,
				artifactPath: unitPath,
			};
		}
		const enable = this.systemctl("enable", unitFile);
		if (enable.code !== 0) {
			return { ok: false, message: `systemctl enable failed: ${enable.stderr.trim()}`, artifactPath: unitPath };
		}
		// `restart` (not `start`) so a reconfigure of an already-running unit picks
		// up the new ExecStart; on a fresh install it simply starts the unit.
		const restart = this.systemctl("restart", unitFile);
		if (restart.code !== 0) {
			return { ok: false, message: `systemctl restart failed: ${restart.stderr.trim()}`, artifactPath: unitPath };
		}
		return {
			ok: true,
			message: wasInstalled
				? `Reconfigured and restarted systemd user service "${config.name}".`
				: `Installed and started systemd user service "${config.name}".`,
			artifactPath: unitPath,
			hints,
		};
	}

	async uninstall(config: ServiceConfig): Promise<ServiceActionResult> {
		const unitPath = this.unitPath(config.name);
		// Best-effort stop+disable; ignore failures (it may already be gone).
		this.systemctl("disable", "--now", this.unitFileName(config.name));
		if (existsSync(unitPath)) {
			await rm(unitPath, { force: true });
		}
		this.systemctl("daemon-reload");
		return { ok: true, message: `Removed systemd user service "${config.name}".`, artifactPath: unitPath };
	}

	async start(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.systemctl("start", this.unitFileName(config.name));
			return result.code === 0
				? { ok: true, message: `Started "${config.name}".` }
				: { ok: false, message: `Failed to start "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async stop(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.systemctl("stop", this.unitFileName(config.name));
			return result.code === 0
				? { ok: true, message: `Stopped "${config.name}".` }
				: { ok: false, message: `Failed to stop "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async restart(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.systemctl("restart", this.unitFileName(config.name));
			return result.code === 0
				? { ok: true, message: `Restarted "${config.name}".` }
				: { ok: false, message: `Failed to restart "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async status(config: ServiceConfig): Promise<ServiceStatus> {
		if (!existsSync(this.unitPath(config.name))) {
			return { installed: false, running: false, enabled: false };
		}
		const unit = this.unitFileName(config.name);
		const isActive = this.systemctl("is-active", unit);
		const isEnabled = this.systemctl("is-enabled", unit);
		const mainPid = this.systemctl("show", unit, "-p", "MainPID", "--value");
		const pid = Number.parseInt(mainPid.stdout.trim(), 10);
		const running = isActive.stdout.trim() === "active";
		return {
			installed: true,
			running,
			enabled: isEnabled.stdout.trim() === "enabled",
			pid: running && Number.isFinite(pid) && pid > 0 ? pid : undefined,
			detail: isActive.stdout.trim(),
		};
	}

	private requireInstalled(config: ServiceConfig, action: () => ServiceActionResult): ServiceActionResult {
		if (!existsSync(this.unitPath(config.name))) {
			return {
				ok: false,
				message: `Service "${config.name}" is not installed. Run "kanban service install" first.`,
			};
		}
		return action();
	}

	private currentUser(): string {
		return process.env.USER ?? process.env.LOGNAME ?? "$USER";
	}
}
