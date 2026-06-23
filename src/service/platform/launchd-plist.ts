/**
 * Pure renderer for a macOS launchd **LaunchAgent** property list.
 *
 * LaunchAgents live at `~/Library/LaunchAgents/<label>.plist` and run in the
 * user's login session. `RunAtLoad` starts it at login; `KeepAlive` respawns
 * it on crash. stdout/stderr are redirected to the log directory.
 */

import { join } from "node:path";

import { buildServiceCommand } from "../service-launch";
import type { ServiceConfig } from "../service-types";

/** Reverse-dns launchd label for a given service name. */
export function buildLaunchdLabel(name: string): string {
	return `ai.capsio.${name}`;
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stringElement(value: string): string {
	return `\t\t<string>${escapeXml(value)}</string>`;
}

/** Path to the LaunchAgent stdout log for a service. */
export function launchdStdoutPath(config: ServiceConfig): string {
	return join(config.logDir, `${config.name}.out.log`);
}

/** Path to the LaunchAgent stderr log for a service. */
export function launchdStderrPath(config: ServiceConfig): string {
	return join(config.logDir, `${config.name}.err.log`);
}

/** Render the full LaunchAgent plist contents. */
export function buildLaunchdPlist(config: ServiceConfig): string {
	const label = buildLaunchdLabel(config.name);
	const programArguments = buildServiceCommand(config).map(stringElement).join("\n");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${escapeXml(label)}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		programArguments,
		"\t</array>",
		"\t<key>WorkingDirectory</key>",
		`\t<string>${escapeXml(config.workingDir)}</string>`,
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<true/>",
		"\t<key>StandardOutPath</key>",
		`\t<string>${escapeXml(launchdStdoutPath(config))}</string>`,
		"\t<key>StandardErrorPath</key>",
		`\t<string>${escapeXml(launchdStderrPath(config))}</string>`,
		"\t<key>EnvironmentVariables</key>",
		"\t<dict>",
		"\t\t<key>KANBAN_LOG_FILE</key>",
		"\t\t<string>1</string>",
		"\t</dict>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}
