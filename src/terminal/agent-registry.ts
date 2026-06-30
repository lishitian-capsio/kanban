import type { RuntimeConfigState } from "../config/runtime-config";
import { getRuntimeLaunchSupportedAgentCatalog, RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type {
	RuntimeAgentDefinition,
	RuntimeAgentId,
	RuntimeConfigResponse,
	RuntimeKanbanProviderSettings,
} from "../core/api-contract";
import { isBinaryAvailableOnPath, resolveBinaryPathOnPath } from "./command-discovery";

export interface ResolvedAgentCommand {
	agentId: RuntimeAgentId;
	label: string;
	command: string;
	binary: string;
	args: string[];
}

/**
 * Resolves a per-agent absolute executable-path override (machine-local), or a
 * falsy value when the agent should fall back to discovering its catalog binary
 * on `$PATH`. Injected so resolution stays pure and testable; callers supply the
 * store-backed lookup (`getAgentExecutablePath`).
 */
export type AgentExecutablePathResolver = (agentId: RuntimeAgentId) => string | null | undefined;

/**
 * The effective binary for an agent: its explicit override when one is set, else
 * the catalog default discovered on `$PATH`.
 */
function resolveEffectiveBinary(
	agentId: RuntimeAgentId,
	catalogBinary: string,
	getExecutablePath?: AgentExecutablePathResolver,
): string {
	const override = getExecutablePath?.(agentId)?.trim();
	return override || catalogBinary;
}

function getDefaultArgs(agentId: RuntimeAgentId): string[] {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		return [];
	}
	return [...entry.baseArgs];
}

function quoteForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function joinCommand(binary: string, args: string[]): string {
	if (args.length === 0) {
		return binary;
	}
	return [binary, ...args.map(quoteForDisplay)].join(" ");
}

function parseBooleanEnvValue(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isRuntimeDebugModeEnabled(): boolean {
	const debugModeValue = process.env.KANBAN_DEBUG_MODE ?? process.env.DEBUG_MODE ?? process.env.debug_mode;
	return parseBooleanEnvValue(debugModeValue);
}

export function detectInstalledCommands(): string[] {
	const candidates = [...RUNTIME_AGENT_CATALOG.map((entry) => entry.binary), "npx"];
	const detected: string[] = [];

	for (const candidate of candidates) {
		if (isBinaryAvailableOnPath(candidate)) {
			detected.push(candidate);
		}
	}

	return detected;
}

function getCuratedDefinitions(
	runtimeConfig: RuntimeConfigState,
	detected: string[],
	getExecutablePath?: AgentExecutablePathResolver,
): RuntimeAgentDefinition[] {
	const detectedSet = new Set(detected);
	return getRuntimeLaunchSupportedAgentCatalog().map((entry) => {
		const defaultArgs = getDefaultArgs(entry.id);
		const override = getExecutablePath?.(entry.id)?.trim();
		const effectiveBinary = override || entry.binary;
		const command = joinCommand(effectiveBinary, defaultArgs);
		// An override is detected by probing its absolute path directly (the daemon
		// case where the catalog binary is not on `$PATH`); otherwise fall back to
		// the `$PATH` scan captured in `detected`.
		const isInstalled =
			entry.id === "pi" ? true : override ? isBinaryAvailableOnPath(override) : detectedSet.has(entry.binary);
		// The absolute path Kanban would launch: the override resolved on disk, or
		// the catalog binary resolved on `$PATH`. `pi` is native (no CLI binary), so
		// it has no resolved path. Detection (`isInstalled`) above is unchanged —
		// this only surfaces where the binary lives.
		const resolvedExecutablePath = entry.id === "pi" ? null : resolveBinaryPathOnPath(effectiveBinary);
		return {
			id: entry.id,
			label: entry.label,
			binary: effectiveBinary,
			command,
			defaultArgs,
			installed: isInstalled,
			configured: runtimeConfig.selectedAgentId === entry.id,
			resolvedExecutablePath,
		};
	});
}

export function resolveAgentCommand(
	runtimeConfig: RuntimeConfigState,
	getExecutablePath?: AgentExecutablePathResolver,
): ResolvedAgentCommand | null {
	const selected = getRuntimeLaunchSupportedAgentCatalog().find((entry) => entry.id === runtimeConfig.selectedAgentId);
	if (!selected) {
		return null;
	}
	const defaultArgs = getDefaultArgs(selected.id);
	const effectiveBinary = resolveEffectiveBinary(selected.id, selected.binary, getExecutablePath);
	const command = joinCommand(effectiveBinary, defaultArgs);
	if (isBinaryAvailableOnPath(effectiveBinary)) {
		return {
			agentId: selected.id,
			label: selected.label,
			command,
			binary: effectiveBinary,
			args: defaultArgs,
		};
	}
	return null;
}

export function buildRuntimeConfigResponse(
	runtimeConfig: RuntimeConfigState,
	kanbanProviderSettings: RuntimeKanbanProviderSettings,
	getExecutablePath?: AgentExecutablePathResolver,
): RuntimeConfigResponse {
	const detectedCommands = detectInstalledCommands();
	const agents = getCuratedDefinitions(runtimeConfig, detectedCommands, getExecutablePath);
	const resolved = resolveAgentCommand(runtimeConfig, getExecutablePath);
	const effectiveCommand = resolved ? joinCommand(resolved.binary, resolved.args) : null;

	return {
		selectedAgentId: runtimeConfig.selectedAgentId,
		selectedShortcutLabel: runtimeConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: runtimeConfig.agentAutonomousModeEnabled,
		debugModeEnabled: isRuntimeDebugModeEnabled(),
		effectiveCommand,
		globalConfigPath: runtimeConfig.globalConfigPath,
		projectConfigPath: runtimeConfig.projectConfigPath,
		readyForReviewNotificationsEnabled: runtimeConfig.readyForReviewNotificationsEnabled,
		detectedCommands,
		agents,
		shortcuts: runtimeConfig.shortcuts,
		kanbanProviderSettings,
		commitPromptTemplate: runtimeConfig.commitPromptTemplate,
		openPrPromptTemplate: runtimeConfig.openPrPromptTemplate,
		commitPromptTemplateDefault: runtimeConfig.commitPromptTemplateDefault,
		openPrPromptTemplateDefault: runtimeConfig.openPrPromptTemplateDefault,
		proxyEnabled: runtimeConfig.proxyEnabled,
		proxyHost: runtimeConfig.proxyHost,
		proxyPort: runtimeConfig.proxyPort,
		proxyUsername: runtimeConfig.proxyUsername,
		proxyPassword: runtimeConfig.proxyPassword,
		noProxy: runtimeConfig.noProxy,
	};
}
