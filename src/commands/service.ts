import type { Command } from "commander";

import { printLine } from "../cli-output";
import {
	buildKanbanRuntimeAccessUrls,
	DEFAULT_KANBAN_RUNTIME_HOST,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getLocalNetworkHosts,
	isRemoteRuntimeHost,
	isWildcardBindHost,
	type RuntimePortOption,
} from "../core/runtime-endpoint";
import { createLogger } from "../logging";
import { getPasscodeFilePath, readPersistedPasscode, resolveAndPersistPasscode } from "../security/passcode-store";
import { buildServiceConfig, resolveServicePaths, type ServiceCliOptions } from "../service/service-config";
import { createServiceManager } from "../service/service-manager-factory";
import type { ServiceConfig, ServiceManager } from "../service/service-types";
import { printJson, toErrorMessage } from "./runtime-workspace";

const log = createLogger("cli.service");

interface ServiceIdentityOptions {
	name?: string;
}

interface ServiceInstallOptions extends ServiceIdentityOptions {
	/** Commander stores `--no-passcode` as `false` and `--passcode <value>` as the string. */
	passcode?: boolean | string;
	https?: boolean;
	cert?: string;
	key?: string;
}

/** The runtime bind target read from the program-level global `--host`/`--port` (§6.1). */
interface ServiceBindTarget {
	host?: string;
	port?: RuntimePortOption;
}

/**
 * Resolve the bind port for an installed service from the shared global `--port` option.
 *
 * `service install` reuses the program-level `--host`/`--port` (parsed once by
 * `parseCliPortOption`) instead of a divergent local copy (I7). An installed service needs
 * a stable, known port baked into its unit file, so `auto` — valid for the foreground
 * `kanban serve` — is rejected here.
 */
function resolveServiceBindPort(port: RuntimePortOption | undefined): number | undefined {
	if (!port) {
		return undefined;
	}
	if (port.mode === "auto") {
		throw new Error("`--port auto` is not supported for `service install`. Pick a fixed port (1-65535).");
	}
	return port.value;
}

/** Collect the TLS passthrough flags into the runtime extra-args list. */
function buildExtraArgs(options: ServiceInstallOptions): string[] {
	const extra: string[] = [];
	if (options.https === true) {
		extra.push("--https");
	}
	if (options.cert !== undefined) {
		extra.push("--cert", options.cert);
	}
	if (options.key !== undefined) {
		extra.push("--key", options.key);
	}
	return extra;
}

function resolveConfig(options: ServiceInstallOptions, bind: ServiceBindTarget): ServiceConfig {
	const cliOptions: ServiceCliOptions = {
		name: options.name,
		host: bind.host,
		port: resolveServiceBindPort(bind.port),
		// commander stores `--no-passcode` as `passcode === false` and `--passcode <value>` as the string.
		noPasscode: options.passcode === false,
		extraArgs: buildExtraArgs(options),
	};
	return buildServiceConfig(cliOptions, resolveServicePaths());
}

/** Build a name-only config for lifecycle commands that just identify the service. */
function resolveIdentityConfig(options: ServiceIdentityOptions): ServiceConfig {
	return buildServiceConfig({ name: options.name }, resolveServicePaths());
}

/** Whether the service binds to a non-localhost host (so passcode auth applies). */
function isRemoteServiceConfig(config: ServiceConfig): boolean {
	return isRemoteRuntimeHost(config.host ?? DEFAULT_KANBAN_RUNTIME_HOST);
}

/** Build the access URLs the operator would share, mirroring the runtime's own URL logic. */
function buildServiceAccessUrls(config: ServiceConfig): string[] {
	const https = config.extraArgs?.includes("--https") ?? false;
	const host = config.host ?? DEFAULT_KANBAN_RUNTIME_HOST;
	const port = config.port ?? DEFAULT_KANBAN_RUNTIME_PORT;
	return buildKanbanRuntimeAccessUrls({
		host,
		port,
		https,
		localNetworkHosts: isWildcardBindHost(host) ? getLocalNetworkHosts() : [],
	});
}

/**
 * After installing a remote-bound service, print the passcode + access URL so the
 * operator can share them immediately. The passcode is a secret, so it goes through
 * {@link printLine} (clean stdout) only — never the log file.
 */
function printRemoteAccessInfo(config: ServiceConfig, passcode: string): void {
	printLine("");
	printLine(`🔐 Remote access passcode: ${passcode}`);
	printLine("   Access URLs:");
	for (const url of buildServiceAccessUrls(config)) {
		printLine(`   ${url}`);
	}
	printLine("   Share these with users who need access. View later with `kanban remote passcode show`.");
	printLine("   Full access status: `kanban remote status`");
	printLine("");
}

function createManager(): ServiceManager {
	return createServiceManager();
}

async function runAction(
	verb: "install" | "uninstall" | "start" | "stop" | "restart",
	config: ServiceConfig,
): Promise<void> {
	try {
		const manager = createManager();
		const result = await manager[verb](config);
		printJson({
			ok: result.ok,
			action: verb,
			platform: manager.platform,
			name: config.name,
			message: result.message,
			artifactPath: result.artifactPath,
			hints: result.hints,
		});
		if (!result.ok) {
			process.exitCode = 1;
		}
	} catch (error) {
		log.error(`service ${verb} failed`, { error });
		printJson({ ok: false, action: verb, name: config.name, error: toErrorMessage(error) });
		process.exitCode = 1;
	}
}

async function runStatus(config: ServiceConfig): Promise<void> {
	try {
		const manager = createManager();
		const status = await manager.status(config);
		printJson({
			ok: true,
			action: "status",
			platform: manager.platform,
			name: config.name,
			...status,
		});
		// Surface the passcode (if any) on a separate clean-stdout line — kept out
		// of the JSON so the secret never lands in a piped/logged status document.
		const passcode = await readPersistedPasscode(getPasscodeFilePath());
		if (passcode !== null) {
			printLine(`🔐 Remote access passcode: ${passcode}`);
		}
		// Human-only pointer to the cross-cutting access view (§5.3). Gated on a TTY so it
		// never pollutes a piped/`--json` status document.
		if (process.stdout.isTTY) {
			printLine("For access URL + passcode + health, run `kanban remote status`.");
		}
	} catch (error) {
		log.error("service status failed", { error });
		printJson({ ok: false, action: "status", name: config.name, error: toErrorMessage(error) });
		process.exitCode = 1;
	}
}

export function registerServiceCommand(program: Command): void {
	const service = program
		.command("service")
		.description("Install and control the Kanban runtime as an OS-level background service.");

	service
		.command("install")
		.description("Register the runtime as a background service and enable it at login/boot.")
		.option("--name <name>", 'Service name (default: "kanban").')
		// --host/--port come from the program-level globals (§6.1, shared parser); see the
		// bind target read via optsWithGlobals() below. --passcode/--no-passcode collapse into
		// one boolean|string field (I8); prefer `kanban remote passcode set/disable` (P4) for
		// the persistent case.
		.option("--passcode <value>", "Use a fixed remote-access passcode (persisted; reused on every restart).")
		.option("--no-passcode", "Disable the auto-generated remote-access passcode.")
		.option("--https", "Enable HTTPS (requires --cert and --key).")
		.option("--cert <path>", "Path to a TLS certificate PEM file.")
		.option("--key <path>", "Path to a TLS private key PEM file.")
		.action(async function (this: Command, options: ServiceInstallOptions) {
			const bind = this.optsWithGlobals() as ServiceBindTarget;
			const config = resolveConfig(options, bind);
			const remoteWithPasscode = isRemoteServiceConfig(config) && config.passcode;
			const explicit = typeof options.passcode === "string" ? options.passcode : null;
			// Persist the passcode before the service boots so the running service reuses it.
			const passcode = remoteWithPasscode ? (await resolveAndPersistPasscode({ explicit })).value : null;
			await runAction("install", config);
			if (passcode !== null && process.exitCode !== 1) {
				printRemoteAccessInfo(config, passcode);
			}
		});

	service
		.command("uninstall")
		.description("Remove the background service.")
		.option("--name <name>", 'Service name (default: "kanban").')
		.action(async (options: ServiceIdentityOptions) => {
			await runAction("uninstall", resolveIdentityConfig(options));
		});

	service
		.command("start")
		.description("Start the installed background service.")
		.option("--name <name>", 'Service name (default: "kanban").')
		.action(async (options: ServiceIdentityOptions) => {
			await runAction("start", resolveIdentityConfig(options));
		});

	service
		.command("stop")
		.description("Stop the running background service.")
		.option("--name <name>", 'Service name (default: "kanban").')
		.action(async (options: ServiceIdentityOptions) => {
			await runAction("stop", resolveIdentityConfig(options));
		});

	service
		.command("restart")
		.description("Restart the background service.")
		.option("--name <name>", 'Service name (default: "kanban").')
		.action(async (options: ServiceIdentityOptions) => {
			await runAction("restart", resolveIdentityConfig(options));
		});

	service
		.command("status")
		.description("Print the background service status as JSON.")
		.option("--name <name>", 'Service name (default: "kanban").')
		.action(async (options: ServiceIdentityOptions) => {
			await runStatus(resolveIdentityConfig(options));
		});
}
