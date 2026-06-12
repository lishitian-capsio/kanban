import { readFile } from "node:fs/promises";

import type { ProviderSettings } from "../agent-sdk/kanban/provider-settings-store";
import {
	type RuntimeAgentId,
	type RuntimeAgentProfileRecord,
	type RuntimeAgentProfilesData,
	type RuntimeReasoningEffort,
	runtimeAgentProfileRecordSchema,
	runtimeAgentProfileSelectionSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readShardDir, writeShardDir } from "./sharded-json-store";

/**
 * On-disk persistence for the agent-profile registry, split into two committed
 * artifacts under a workspace directory:
 *
 *   - `agent-profiles/<profileId>.json` — one shard per profile (non-secret config
 *     only; see {@link RuntimeAgentProfileRecord}). Sharding keeps cross-branch edits
 *     to different profiles from colliding on a single file, mirroring the board and
 *     (former) requirement stores.
 *   - `agent-profile-selection.json` — the small `{ selectedByAgent }` map naming each
 *     agent's currently selected profile.
 *
 * Callers (`workspace-state.ts`) are expected to hold the workspace directory lock
 * around a read → mutate → write cycle. The pure registry operations live in
 * `agent-profile-registry.ts`.
 */

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read and assemble the profile registry from its sharded + selection artifacts. */
export async function readAgentProfilesData(
	profilesDir: string,
	selectionPath: string,
): Promise<RuntimeAgentProfilesData> {
	const shardMap = await readShardDir(profilesDir, runtimeAgentProfileRecordSchema);
	const profiles = [...shardMap.values()];

	let selectedByAgent: Record<string, string> = {};
	try {
		const raw = await readFile(selectionPath, "utf8");
		const parsed = runtimeAgentProfileSelectionSchema.safeParse(JSON.parse(raw) as unknown);
		if (parsed.success) {
			selectedByAgent = parsed.data.selectedByAgent;
		}
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			// A torn/invalid selection file should not wipe the profiles; treat it as
			// "nothing selected" and let the next write heal it.
		}
	}

	return { profiles, selectedByAgent };
}

/** Persist the profile registry: one shard per profile + the selection file. */
export async function writeAgentProfilesData(
	profilesDir: string,
	selectionPath: string,
	data: RuntimeAgentProfilesData,
): Promise<void> {
	const shardMap = new Map<string, RuntimeAgentProfileRecord>(data.profiles.map((profile) => [profile.id, profile]));
	await writeShardDir(profilesDir, shardMap);
	await lockedFileSystem.writeJsonFileAtomic(selectionPath, { selectedByAgent: data.selectedByAgent }, { lock: null });
}

const KNOWN_REASONING_EFFORTS: readonly RuntimeReasoningEffort[] = ["low", "medium", "high", "xhigh"];

function toReasoningEffort(effort: string | undefined): RuntimeReasoningEffort | null {
	const trimmed = effort?.trim();
	return trimmed && (KNOWN_REASONING_EFFORTS as readonly string[]).includes(trimmed)
		? (trimmed as RuntimeReasoningEffort)
		: null;
}

/**
 * Convert a machine-home {@link ProviderSettings} blob into a default
 * {@link RuntimeAgentProfileRecord} for `agentId`, copying only NON-SECRET launch
 * config. The API key (and any other secret) is intentionally dropped — it stays in
 * the machine-home store and is resolved by providerId at launch. Returns `null` when
 * there is nothing worth migrating (no settings or no provider). Used by the one-time
 * provider-settings → default-profile migration in `workspace-state.ts`.
 */
export function buildDefaultProfileFromProviderSettings(
	settings: ProviderSettings | null,
	identity: { id: string; name: string; agentId: RuntimeAgentId },
): RuntimeAgentProfileRecord | null {
	const providerId = settings?.provider?.trim();
	if (!providerId) {
		return null;
	}
	return {
		id: identity.id,
		name: identity.name,
		agentId: identity.agentId,
		providerId,
		modelId: settings?.model?.trim() || null,
		baseUrl: settings?.baseUrl?.trim() || null,
		reasoningEffort: toReasoningEffort(settings?.reasoning?.effort),
		region: settings?.region?.trim() || null,
		gcpProjectId: settings?.gcp?.projectId?.trim() || null,
		gcpRegion: settings?.gcp?.region?.trim() || null,
	};
}
