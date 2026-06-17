import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { AgentProviderConfig } from "../agent-sdk/kanban/agent-provider-config";
import {
	type RuntimeAgentId,
	type RuntimeReasoningEffort,
	runtimeAgentIdSchema,
	runtimeReasoningEffortSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readShardDir, writeShardDir } from "./sharded-json-store";

/**
 * Workspace-committed provider configuration.
 *
 * This is the secret-free, git-committed half of an agent's provider. It is the
 * single replacement for the retired "agent profile" concept: the launch-config
 * "workspace layer" is now a committed *provider* (distinguished by its `scope`)
 * rather than a separate profile record + selection layer.
 *
 * SECURITY: committed providers live under `<repo>/.kanban` and are committed to
 * the repo, so they hold only NON-SECRET launch config. The API key (and any other
 * secret) stays in the machine-home per-agent provider store
 * (`~/.kanban/settings/agent_providers.json`), keyed by the same `providerId`, and
 * is resolved at launch. A committed provider record must never carry a secret.
 *
 * On disk (one workspace directory):
 *   - `agent-providers/<providerId>.json` — one shard per committed provider, keyed
 *     by its (normalized) provider id, so cross-branch edits to different providers
 *     never collide (mirrors the board / requirement shard stores).
 *   - `agent-provider-selection.json` — the small `{ selectedByAgent }` map naming
 *     each agent's currently selected committed provider id.
 *
 * Callers (`workspace-state.ts`) hold the workspace directory lock around a
 * read → mutate → write cycle.
 */

export const committedProviderRecordSchema = z.object({
	/** Normalized provider id (the provider name); also the shard filename. */
	providerId: z.string().min(1),
	agentId: runtimeAgentIdSchema,
	/** Marks this provider as the workspace-committed (secret-free) variant. */
	scope: z.literal("workspace").default("workspace"),
	modelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	reasoningEffort: runtimeReasoningEffortSchema.nullable(),
	region: z.string().nullable(),
	gcpProjectId: z.string().nullable(),
	gcpRegion: z.string().nullable(),
});
export type CommittedProviderRecord = z.infer<typeof committedProviderRecordSchema>;

/** In-memory aggregate (assembled from per-id shards + the selection file). */
export const committedProvidersDataSchema = z.object({
	providers: z.array(committedProviderRecordSchema).default([]),
	selectedByAgent: z.record(z.string(), z.string()).default({}),
});
export type CommittedProvidersData = z.infer<typeof committedProvidersDataSchema>;

/** On-disk selection file shape (sibling to the sharded `agent-providers/` dir). */
const committedProviderSelectionSchema = z.object({
	selectedByAgent: z.record(z.string(), z.string()).default({}),
});

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** The id used to address a committed provider (its normalized provider name). */
export function normalizeProviderId(providerId: string | undefined | null): string {
	return (providerId ?? "").trim().toLowerCase();
}

const KNOWN_REASONING_EFFORTS: readonly RuntimeReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/** Coerce a free-form effort string to a known {@link RuntimeReasoningEffort}, else null. */
function toReasoningEffort(effort: string | undefined): RuntimeReasoningEffort | null {
	const trimmed = effort?.trim();
	return trimmed && (KNOWN_REASONING_EFFORTS as readonly string[]).includes(trimmed)
		? (trimmed as RuntimeReasoningEffort)
		: null;
}

/** Read and assemble the committed-provider registry from its sharded + selection artifacts. */
export async function readCommittedProviders(
	providersDir: string,
	selectionPath: string,
): Promise<CommittedProvidersData> {
	const shardMap = await readShardDir(providersDir, committedProviderRecordSchema);
	const providers = [...shardMap.values()];

	let selectedByAgent: Record<string, string> = {};
	try {
		const raw = await readFile(selectionPath, "utf8");
		const parsed = committedProviderSelectionSchema.safeParse(JSON.parse(raw) as unknown);
		if (parsed.success) {
			selectedByAgent = parsed.data.selectedByAgent;
		}
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			// A torn/invalid selection file should not wipe the providers; treat it as
			// "nothing selected" and let the next write heal it.
		}
	}

	return { providers, selectedByAgent };
}

/** Persist the committed-provider registry: one shard per provider + the selection file. */
export async function writeCommittedProviders(
	providersDir: string,
	selectionPath: string,
	data: CommittedProvidersData,
): Promise<void> {
	const shardMap = new Map<string, CommittedProviderRecord>(
		data.providers.map((provider) => [provider.providerId, provider]),
	);
	await writeShardDir(providersDir, shardMap);
	await lockedFileSystem.writeJsonFileAtomic(selectionPath, { selectedByAgent: data.selectedByAgent }, { lock: null });
}

/** Resolve the currently selected committed provider for an agent, or null if none/dangling. */
export function getSelectedCommittedProvider(
	data: CommittedProvidersData,
	agentId: RuntimeAgentId,
): CommittedProviderRecord | null {
	const selectedId = data.selectedByAgent[agentId];
	if (!selectedId) {
		return null;
	}
	return data.providers.find((provider) => provider.providerId === selectedId) ?? null;
}

/**
 * Convert an {@link AgentProviderConfig} blob into a workspace-committed provider
 * record for `agentId`, copying only NON-SECRET launch config. The API key (and any
 * other secret) is intentionally dropped — it stays in the machine-home per-agent
 * provider store and is resolved at launch. Returns `null` when there is nothing
 * worth committing (no config or no provider). Used by the one-time migration in
 * `workspace-state.ts`.
 */
export function buildCommittedProviderFromProviderSettings(
	config: AgentProviderConfig | null,
	agentId: RuntimeAgentId,
): CommittedProviderRecord | null {
	const providerId = normalizeProviderId(config?.provider);
	if (!providerId) {
		return null;
	}
	return {
		providerId,
		agentId,
		scope: "workspace",
		modelId: config?.model?.trim() || null,
		baseUrl: config?.baseUrl?.trim() || null,
		reasoningEffort: toReasoningEffort(config?.reasoning?.effort),
		region: config?.region?.trim() || null,
		gcpProjectId: config?.gcp?.projectId?.trim() || null,
		gcpRegion: config?.gcp?.region?.trim() || null,
	};
}

/** The fields a committed provider contributes to a pi launch (secret-free). */
export interface CommittedProviderLaunchFields {
	providerId: string | null;
	modelId: string | null;
	baseUrl: string | null;
	reasoningEffort: RuntimeReasoningEffort | null;
}
