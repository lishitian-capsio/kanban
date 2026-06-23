/**
 * Pure renderer for a systemd **user** service unit file.
 *
 * User services live at `~/.config/systemd/user/<name>.service` and start at
 * login (with `loginctl enable-linger` they also survive logout / start at
 * boot). stdout/stderr is captured by journald, so no log files are declared.
 */

import { buildServiceCommand } from "../service-launch";
import type { ServiceConfig } from "../service-types";

/** Quote a single ExecStart token if it contains whitespace. */
function quoteToken(token: string): string {
	return /\s/.test(token) ? `"${token}"` : token;
}

/** Render the full `<name>.service` unit file contents. */
export function buildSystemdUnit(config: ServiceConfig): string {
	const execStart = buildServiceCommand(config).map(quoteToken).join(" ");
	return [
		"[Unit]",
		"Description=Kanban runtime (local orchestration board for coding agents)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${config.workingDir}`,
		`ExecStart=${execStart}`,
		"Restart=on-failure",
		"RestartSec=5",
		// Persist a rotating log file in addition to journald output.
		"Environment=KANBAN_LOG_FILE=1",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}
