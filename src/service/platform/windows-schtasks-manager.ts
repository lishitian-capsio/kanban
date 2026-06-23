/**
 * Windows service manager backed by **Task Scheduler** (`schtasks.exe`).
 *
 * Task Scheduler needs no third-party dependency and an `ONLOGON` trigger
 * requires no administrator rights, so this is the zero-dependency default.
 * The scheduler persists the task definition itself (there is no plist/unit
 * file on disk), so installation state is read back via `schtasks /Query`.
 *
 * For a true always-on Windows *Service* (starts before login, survives
 * logout), the README documents wrapping the same launch command with NSSM.
 */

import { spawnSyncRunner } from "../command-runner";
import type {
	CommandRunner,
	ServiceActionResult,
	ServiceConfig,
	ServiceManager,
	ServiceStatus,
} from "../service-types";
import {
	buildSchtasksCreateArgs,
	buildSchtasksDeleteArgs,
	buildSchtasksEndArgs,
	buildSchtasksQueryArgs,
	buildSchtasksRunArgs,
} from "./schtasks";

interface WindowsSchtasksManagerOptions {
	runner?: CommandRunner;
}

export class WindowsSchtasksManager implements ServiceManager {
	readonly platform = "schtasks";
	private readonly runner: CommandRunner;

	constructor(options: WindowsSchtasksManagerOptions = {}) {
		this.runner = options.runner ?? spawnSyncRunner;
	}

	private schtasks(args: string[]) {
		return this.runner("schtasks", args);
	}

	private isInstalled(config: ServiceConfig): boolean {
		return this.schtasks(buildSchtasksQueryArgs(config.name)).code === 0;
	}

	async install(config: ServiceConfig): Promise<ServiceActionResult> {
		const create = this.schtasks(buildSchtasksCreateArgs(config));
		if (create.code !== 0) {
			return { ok: false, message: `schtasks /Create failed: ${create.stderr.trim() || create.stdout.trim()}` };
		}
		return {
			ok: true,
			message: `Installed scheduled task "${config.name}" (runs at logon).`,
			hints: [
				`Logs are written to ${config.logDir} (set KANBAN_LOG_FILE).`,
				"For an always-on Windows Service (starts before login), wrap this command with NSSM — see the README.",
			],
		};
	}

	async uninstall(config: ServiceConfig): Promise<ServiceActionResult> {
		const result = this.schtasks(buildSchtasksDeleteArgs(config.name));
		if (result.code !== 0) {
			return { ok: false, message: `schtasks /Delete failed: ${result.stderr.trim() || result.stdout.trim()}` };
		}
		return { ok: true, message: `Removed scheduled task "${config.name}".` };
	}

	async start(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.schtasks(buildSchtasksRunArgs(config.name));
			return result.code === 0
				? { ok: true, message: `Started "${config.name}".` }
				: { ok: false, message: `Failed to start "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async stop(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			const result = this.schtasks(buildSchtasksEndArgs(config.name));
			return result.code === 0
				? { ok: true, message: `Stopped "${config.name}".` }
				: { ok: false, message: `Failed to stop "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async restart(config: ServiceConfig): Promise<ServiceActionResult> {
		return this.requireInstalled(config, () => {
			this.schtasks(buildSchtasksEndArgs(config.name));
			const result = this.schtasks(buildSchtasksRunArgs(config.name));
			return result.code === 0
				? { ok: true, message: `Restarted "${config.name}".` }
				: { ok: false, message: `Failed to restart "${config.name}": ${result.stderr.trim()}` };
		});
	}

	async status(config: ServiceConfig): Promise<ServiceStatus> {
		const query = this.schtasks(buildSchtasksQueryArgs(config.name));
		if (query.code !== 0) {
			return { installed: false, running: false, enabled: false };
		}
		const statusLine = query.stdout.match(/^\s*Status:\s*(.+)$/im)?.[1]?.trim() ?? "";
		const stateLine = query.stdout.match(/Scheduled Task State:\s*(.+)$/im)?.[1]?.trim() ?? "";
		return {
			installed: true,
			running: /running/i.test(statusLine),
			enabled: /enabled/i.test(stateLine),
			detail: statusLine || undefined,
		};
	}

	private requireInstalled(config: ServiceConfig, action: () => ServiceActionResult): ServiceActionResult {
		if (!this.isInstalled(config)) {
			return {
				ok: false,
				message: `Service "${config.name}" is not installed. Run "kanban service install" first.`,
			};
		}
		return action();
	}
}
