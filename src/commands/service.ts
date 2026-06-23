import type { Command } from "commander";

import { createLogger } from "../logging";
import { buildServiceConfig, resolveServicePaths, type ServiceCliOptions } from "../service/service-config";
import { createServiceManager } from "../service/service-manager-factory";
import type { ServiceConfig, ServiceManager } from "../service/service-types";
import { printJson, toErrorMessage } from "./runtime-workspace";

const log = createLogger("cli.service");

interface ServiceIdentityOptions {
	name?: string;
}

interface ServiceInstallOptions extends ServiceIdentityOptions {
	host?: string;
	port?: number;
	passcode?: boolean;
	https?: boolean;
	cert?: string;
	key?: string;
}

function parseServicePort(value: string): number {
	const port = Number.parseInt(value, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid --port "${value}". Expected an integer between 1 and 65535.`);
	}
	return port;
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

function resolveConfig(options: ServiceInstallOptions): ServiceConfig {
	const cliOptions: ServiceCliOptions = {
		name: options.name,
		host: options.host,
		port: options.port,
		// commander stores `--no-passcode` as `passcode === false`.
		noPasscode: options.passcode === false,
		extraArgs: buildExtraArgs(options),
	};
	return buildServiceConfig(cliOptions, resolveServicePaths());
}

/** Build a name-only config for lifecycle commands that just identify the service. */
function resolveIdentityConfig(options: ServiceIdentityOptions): ServiceConfig {
	return buildServiceConfig({ name: options.name }, resolveServicePaths());
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
		.option("--host <ip>", "Host IP the runtime binds to (default: 127.0.0.1).")
		.option("--port <number>", "Runtime port (1-65535).", parseServicePort)
		.option("--no-passcode", "Disable the auto-generated remote-access passcode.")
		.option("--https", "Enable HTTPS (requires --cert and --key).")
		.option("--cert <path>", "Path to a TLS certificate PEM file.")
		.option("--key <path>", "Path to a TLS private key PEM file.")
		.action(async (options: ServiceInstallOptions) => {
			await runAction("install", resolveConfig(options));
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
