/**
 * `kanban remote …` — the remote-access subsystem (design doc §5, phase P4).
 *
 * Consolidates the host / CORS / passcode / health story into one discoverable noun. A
 * separate `remote` noun (not folded into `service`) because remote access applies to the
 * bare `kanban --host …` launch too, not only an installed service (§10 Q3).
 *
 *   kanban remote status               — the hub: bind, access URLs, passcode presence, health
 *   kanban remote passcode show        — print the persisted passcode (human channel only)
 *   kanban remote passcode set <value> — persist a fixed passcode (reused on every launch)
 *   kanban remote passcode disable     — persist the `--no-passcode` equivalent
 *
 * Secrets invariant (§2 P8, preserved from `service.ts`): the passcode value never enters the
 * machine channel (`--json`) or any log — only the human channel via `printLine`.
 */

import type { Command } from "commander";

import { emitDeprecationWarning, printLine } from "../cli-output";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	getLocalNetworkHosts,
	getRuntimeFetch,
	isKanbanRuntimeHttps,
	isLoopbackHost,
	isWildcardBindHost,
	type RuntimePortOption,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../core/runtime-endpoint";
import { createLogger } from "../logging";
import {
	disablePersistedPasscode,
	getPasscodeFilePath,
	readPersistedPasscodeRecord,
	resolveAndPersistPasscode,
} from "../security/passcode-store";
import { getAllowedHostHeaders } from "../server/middleware";
import { createServiceManager } from "../service/service-manager-factory";
import { DEFAULT_SERVICE_NAME } from "../service/service-types";
import { readGlobalCliOptions, runCliCommand } from "./cli-command-runner";
import {
	buildRemoteStatusData,
	type RemoteHealth,
	type RemoteServiceInfo,
	type RemoteStatusData,
} from "./remote-status";

const log = createLogger("cli.remote");

/** Bind/target options merged onto a `remote` action from the program-level globals (§6.1). */
interface RemoteBindTarget {
	host?: string;
	port?: RuntimePortOption;
}

/**
 * Point the runtime endpoint at the `--host`/`--port` the operator passed so every derived
 * value (bind view, access URLs, Host gate, health URL) reflects that target. `--port auto`
 * is meaningless for a status target and is ignored.
 */
function applyRemoteBindTarget(target: RemoteBindTarget): void {
	if (target.host) {
		setKanbanRuntimeHost(target.host);
	}
	if (target.port?.mode === "fixed") {
		setKanbanRuntimePort(target.port.value);
	}
}

/** Probe the targeted runtime's reachability + latency (best-effort; never throws). */
async function probeRuntimeHealth(): Promise<RemoteHealth> {
	const checkedUrl = buildKanbanRuntimeUrl("/api/trpc/projects.list");
	const startedAt = Date.now();
	try {
		const runtimeFetch = await getRuntimeFetch();
		const response = await runtimeFetch(checkedUrl, {
			method: "GET",
			signal: AbortSignal.timeout(1_500),
		});
		const latencyMs = Date.now() - startedAt;
		if (response.status === 404) {
			return { reachable: false, checkedUrl, latencyMs };
		}
		const payload = (await response.json().catch(() => null)) as {
			result?: unknown;
			error?: unknown;
		} | null;
		return { reachable: Boolean(payload && (payload.result || payload.error)), checkedUrl, latencyMs };
	} catch {
		return { reachable: false, checkedUrl, latencyMs: null };
	}
}

/**
 * Best-effort installed-service summary. Returns `null` on an unsupported platform or any
 * probe failure so `remote status` still answers the access question without a service.
 */
async function probeServiceInfo(name: string): Promise<RemoteServiceInfo | null> {
	try {
		const manager = createServiceManager();
		const status = await manager.status({
			// status() only reads the named artifact; the launch paths are unused here.
			name,
			bunPath: "",
			scriptPath: "",
			workingDir: "",
			logDir: "",
			passcode: true,
		});
		return {
			installed: status.installed,
			running: status.running,
			platform: manager.platform,
			name,
		};
	} catch (error) {
		log.debug("service status probe failed; omitting from remote status", { error });
		return null;
	}
}

/** Render the compact human panel for `remote status` (design doc §5.1). */
function renderRemoteStatusPanel(data: RemoteStatusData): string {
	const lines: string[] = [];
	const scheme = data.bind.https ? "https" : "http";
	lines.push(`Remote access — bound to ${scheme}://${data.bind.host}:${data.bind.port}`);
	lines.push(`  mode:    ${data.remoteMode ? "remote (non-loopback)" : "local (loopback only)"}`);
	lines.push("  URLs:");
	for (const url of data.accessUrls) {
		lines.push(`    ${url}`);
	}
	const passcode = data.passcode.required
		? data.passcode.set
			? `🔐 set — view with \`${data.passcode.viewCommand}\``
			: "⚠️  required but not set"
		: data.remoteMode
			? "disabled (--no-passcode)"
			: "not required (local-only)";
	lines.push(`  passcode: ${passcode}`);
	lines.push(
		`  health:  ${data.health.reachable ? `✓ reachable (${data.health.latencyMs ?? "?"}ms)` : "✗ unreachable"}`,
	);
	if (data.allowedHosts.length > 0) {
		lines.push(`  allowed Host headers: ${data.allowedHosts.join(", ")}`);
	}
	if (data.service) {
		lines.push(
			`  service: ${data.service.installed ? "installed" : "not installed"}` +
				`${data.service.installed ? (data.service.running ? ", running" : ", stopped") : ""} (${data.service.platform}: ${data.service.name})`,
		);
	}
	return lines.join("\n");
}

/** Resolve the `remote status` data object from disk + network + service facts. */
async function buildRemoteStatus(serviceName: string): Promise<RemoteStatusData> {
	const host = getKanbanRuntimeHost();
	const passcodeRecord = await readPersistedPasscodeRecord(getPasscodeFilePath());
	const [health, service] = await Promise.all([probeRuntimeHealth(), probeServiceInfo(serviceName)]);
	return buildRemoteStatusData({
		bind: { host, port: getKanbanRuntimePort(), https: isKanbanRuntimeHttps() },
		isLoopbackBind: isLoopbackHost(host),
		isWildcardBind: isWildcardBindHost(host),
		localNetworkHosts: getLocalNetworkHosts(),
		allowedHostAuthorities: [...getAllowedHostHeaders()],
		passcode: { value: passcodeRecord.value, disabled: passcodeRecord.disabled },
		health,
		service,
	});
}

/**
 * Print the persisted passcode on the human channel only. Shared by `remote passcode show`
 * and the deprecated top-level `kanban passcode` alias. Never emits the value as JSON.
 */
export async function runRemotePasscodeShow(): Promise<void> {
	const record = await readPersistedPasscodeRecord(getPasscodeFilePath());
	if (record.disabled) {
		printLine(
			"Remote-access passcode is disabled (`kanban remote passcode disable`).\n" +
				"Re-enable with `kanban remote passcode set <value>`.",
		);
		return;
	}
	if (!record.value) {
		printLine(
			"No remote-access passcode is set yet.\n" +
				"It is created the first time Kanban binds to a non-localhost host — e.g.\n" +
				"  kanban --host <ip>            (or `kanban service install --host <ip>`)\n" +
				"To pin a fixed one: `kanban remote passcode set <value>` or `kanban --host <ip> --passcode <value>`.",
		);
		return;
	}
	printLine(`🔐 Remote access passcode: ${record.value}`);
}

export function registerRemoteCommand(program: Command): void {
	const remote = program
		.command("remote")
		.description("Inspect and manage remote (network) access: bind, access URLs, passcode, health.");

	remote
		.command("status")
		.description("Show how to reach this runtime: bind host, access URLs, passcode presence, and health.")
		.option("--name <name>", `Installed service name to report on (default: "${DEFAULT_SERVICE_NAME}").`)
		.addHelpText("after", "\nExamples:\n  kanban remote status\n  kanban remote status --host 0.0.0.0 --json")
		.action(async function (this: Command, options: { name?: string }) {
			const globals = readGlobalCliOptions(this);
			applyRemoteBindTarget(this.optsWithGlobals() as RemoteBindTarget);
			const serviceName = options.name ?? DEFAULT_SERVICE_NAME;
			await runCliCommand("remote.status", async () => ({ ...(await buildRemoteStatus(serviceName)) }), {
				globals,
				renderHuman: (data) => renderRemoteStatusPanel(data as unknown as RemoteStatusData),
			});
		});

	const passcode = remote.command("passcode").description("Manage the persisted remote-access passcode.");

	passcode
		.command("show")
		.description("Print the current remote-access passcode (sensitive — written to stdout only).")
		.action(async () => {
			await runRemotePasscodeShow();
		});

	passcode
		.command("set <value>")
		.description("Persist a fixed remote-access passcode (reused on every launch; re-enables if disabled).")
		.action(async function (this: Command, value: string) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"remote.passcode.set",
				async () => {
					const resolved = await resolveAndPersistPasscode({ explicit: value });
					// Confirmation only — never echo the secret into the machine channel.
					return { ok: true, persisted: true, source: resolved.source };
				},
				{
					globals,
					renderHuman: () =>
						"🔐 Remote-access passcode updated and persisted.\n" +
						"   View it with `kanban remote passcode show`.",
				},
			);
		});

	passcode
		.command("disable")
		.description("Disable remote-access passcode auth and persist it (the `--no-passcode` equivalent).")
		.action(async function (this: Command) {
			const globals = readGlobalCliOptions(this);
			await runCliCommand(
				"remote.passcode.disable",
				async () => {
					await disablePersistedPasscode(getPasscodeFilePath());
					return { ok: true, disabled: true };
				},
				{
					globals,
					renderHuman: () =>
						"Remote-access passcode disabled and persisted (equivalent to launching with --no-passcode).\n" +
						"   Re-enable with `kanban remote passcode set <value>`.",
				},
			);
		});
}

/**
 * `kanban passcode` — deprecated top-level alias of `kanban remote passcode show` (§5.2 / §8).
 * Kept working for one minor-version window with a stderr deprecation note.
 */
export function registerPasscodeAliasCommand(program: Command): void {
	program
		.command("passcode")
		.description("Deprecated alias of `kanban remote passcode show`.")
		.action(async () => {
			emitDeprecationWarning("`kanban passcode` is deprecated; use `kanban remote passcode show`.");
			await runRemotePasscodeShow();
		});
}
