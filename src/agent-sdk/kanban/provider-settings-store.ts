// Kanban-native provider settings store.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockedFileSystem } from "../../fs/locked-file-system";

// ------------------------------------------------------------------ types

export interface ProviderSettingsReasoning {
	enabled?: boolean;
	effort?: string;
	budgetTokens?: number;
}

export interface ProviderSettingsAuth {
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
	expiresAt?: number;
	apiKey?: string;
}

export interface ProviderSettings {
	provider: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	reasoning?: ProviderSettingsReasoning;
	auth?: ProviderSettingsAuth;
	aws?: Record<string, unknown>;
	gcp?: { projectId?: string; region?: string };
	headers?: Record<string, string>;
	timeout?: number;
	region?: string;
	oca?: { mode: string };
	[key: string]: unknown;
}

export type ProviderTokenSource = "oauth" | "manual";

interface ProviderEntry {
	settings: ProviderSettings;
	tokenSource?: ProviderTokenSource;
}

interface ProviderSettingsFile {
	providers: Record<string, ProviderEntry>;
	lastUsedProvider?: string;
}

export interface SaveProviderSettingsInput {
	settings: ProviderSettings;
	tokenSource?: ProviderTokenSource;
	setLastUsed?: boolean;
}

// ------------------------------------------------------------------ paths

const KANBAN_SETTINGS_DIR = join(homedir(), ".kanban", "settings");
const KANBAN_PROVIDER_SETTINGS_PATH = join(KANBAN_SETTINGS_DIR, "provider_settings.json");

export function resolveProviderSettingsPath(): string {
	const envOverride = process.env.KANBAN_PROVIDER_SETTINGS_PATH?.trim();
	if (envOverride) {
		return envOverride;
	}
	return KANBAN_PROVIDER_SETTINGS_PATH;
}

// ------------------------------------------------------------------ store

let cachedState: ProviderSettingsFile | null = null;

function readStore(path: string): ProviderSettingsFile {
	if (!existsSync(path)) {
		return { providers: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<ProviderSettingsFile>;
		return {
			providers: parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {},
			lastUsedProvider: typeof parsed.lastUsedProvider === "string" ? parsed.lastUsedProvider : undefined,
		};
	} catch {
		return { providers: {} };
	}
}

function loadState(): ProviderSettingsFile {
	if (cachedState) {
		return cachedState;
	}

	const path = resolveProviderSettingsPath();
	const state = readStore(path);

	cachedState = state;
	return state;
}

async function writeStore(state: ProviderSettingsFile): Promise<void> {
	const path = resolveProviderSettingsPath();
	await lockedFileSystem.writeJsonFileAtomic(path, state, {
		lock: { path, type: "file" },
	});
	cachedState = state;
}

function normalizeProviderId(providerId: string): string {
	return providerId.trim().toLowerCase();
}

// ------------------------------------------------------------------ public API

export function getProviderSettings(providerId: string): ProviderSettings | null {
	const state = loadState();
	const normalized = normalizeProviderId(providerId);
	const entry = state.providers[normalized];
	return entry?.settings ?? null;
}

export function getLastUsedProviderSettings(): ProviderSettings | null {
	const state = loadState();
	const lastUsedId = state.lastUsedProvider?.trim().toLowerCase();
	if (!lastUsedId) {
		return null;
	}
	const entry = state.providers[lastUsedId];
	return entry?.settings ?? null;
}

export function getLastUsedProviderId(): string | null {
	const state = loadState();
	return state.lastUsedProvider?.trim() || null;
}

export function getAllProviders(): Record<string, ProviderSettings> {
	const state = loadState();
	const result: Record<string, ProviderSettings> = {};
	for (const [id, entry] of Object.entries(state.providers)) {
		result[id] = entry.settings;
	}
	return result;
}

export function saveProviderSettings(input: SaveProviderSettingsInput): void {
	const state = loadState();
	const providerId = normalizeProviderId(input.settings.provider);

	const settings: ProviderSettings = {
		...input.settings,
		provider: providerId,
	};

	// Trim/clean string fields
	if (settings.model !== undefined) {
		const model = settings.model.trim();
		if (!model) {
			delete settings.model;
		} else {
			settings.model = model;
		}
	}
	if (settings.baseUrl !== undefined) {
		const baseUrl = settings.baseUrl.trim();
		if (!baseUrl) {
			delete settings.baseUrl;
		} else {
			settings.baseUrl = baseUrl;
		}
	}
	if (settings.apiKey !== undefined) {
		const apiKey = settings.apiKey.trim();
		if (!apiKey) {
			delete settings.apiKey;
		} else {
			settings.apiKey = apiKey;
		}
	}
	if (settings.reasoning) {
		const reasoning = { ...settings.reasoning };
		if (typeof reasoning.effort === "string") {
			const effort = reasoning.effort.trim();
			if (!effort) {
				delete reasoning.effort;
			} else {
				reasoning.effort = effort;
			}
		}
		if (reasoning.enabled === undefined && reasoning.effort === undefined && reasoning.budgetTokens === undefined) {
			delete settings.reasoning;
		} else {
			settings.reasoning = reasoning;
		}
	}
	if (settings.auth) {
		const auth = { ...settings.auth };
		if (auth.accountId !== undefined && auth.accountId !== null) {
			const accountId = auth.accountId.trim();
			auth.accountId = accountId || undefined;
		}
		settings.auth = auth;
	}

	const existingEntry = state.providers[providerId];
	state.providers[providerId] = {
		settings,
		tokenSource: input.tokenSource ?? existingEntry?.tokenSource ?? "manual",
	};

	if (input.setLastUsed) {
		state.lastUsedProvider = providerId;
	}

	void writeStore(state);
}

export function deleteProviderSettings(providerId: string): void {
	const state = loadState();
	const normalized = normalizeProviderId(providerId);
	delete state.providers[normalized];
	if (state.lastUsedProvider === normalized) {
		delete state.lastUsedProvider;
	}
	void writeStore(state);
}

/** Reset the in-memory cache (useful for tests). */
export function resetProviderSettingsCache(): void {
	cachedState = null;
}
