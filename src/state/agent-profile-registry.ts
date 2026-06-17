import type { RuntimeAgentId, RuntimeAgentProfileRecord, RuntimeAgentProfilesData } from "../core/api-contract";

/**
 * Pure, I/O-free operations over the in-memory agent-profile registry.
 *
 * Each function takes the current {@link RuntimeAgentProfilesData} plus parameters
 * and returns a new value without mutating the input. Persistence, locking, secret
 * handling, and session wiring live in the surrounding layers
 * (`agent-profile-store.ts`, `workspace-state.ts`, `runtime-api.ts`).
 */

/** Fields a caller may patch on an existing profile (identity + agent are fixed). */
export type AgentProfilePatch = Partial<
	Pick<RuntimeAgentProfileRecord, "name" | "providerId" | "modelId" | "reasoningEffort">
>;

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

/** Throws if `name` collides with another profile of `agentId` (case-insensitive, trimmed). */
function assertNameAvailable(
	data: RuntimeAgentProfilesData,
	agentId: RuntimeAgentId,
	name: string,
	exceptId?: string,
): void {
	const target = normalizeName(name);
	const clash = data.profiles.some(
		(profile) => profile.agentId === agentId && profile.id !== exceptId && normalizeName(profile.name) === target,
	);
	if (clash) {
		throw new Error(`A profile named "${name.trim()}" already exists for agent "${agentId}".`);
	}
}

/** Return profiles sorted by name (case-insensitive), optionally filtered by agent. */
export function listAgentProfiles(
	data: RuntimeAgentProfilesData,
	agentId?: RuntimeAgentId,
): RuntimeAgentProfileRecord[] {
	return data.profiles
		.filter((profile) => (agentId ? profile.agentId === agentId : true))
		.slice()
		.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
}

/**
 * Append a new profile. Throws if the id is already taken or the name collides with
 * another profile of the same agent.
 */
export function createAgentProfile(
	data: RuntimeAgentProfilesData,
	profile: RuntimeAgentProfileRecord,
): RuntimeAgentProfilesData {
	if (data.profiles.some((existing) => existing.id === profile.id)) {
		throw new Error(`Agent profile "${profile.id}" already exists.`);
	}
	assertNameAvailable(data, profile.agentId, profile.name);
	return { ...data, profiles: [...data.profiles, profile] };
}

/** Patch mutable fields of an existing profile. Throws if missing or on a name clash. */
export function updateAgentProfile(
	data: RuntimeAgentProfilesData,
	id: string,
	patch: AgentProfilePatch,
): RuntimeAgentProfilesData {
	const existing = data.profiles.find((profile) => profile.id === id);
	if (!existing) {
		throw new Error(`Agent profile "${id}" not found.`);
	}
	if (patch.name !== undefined) {
		assertNameAvailable(data, existing.agentId, patch.name, id);
	}
	return {
		...data,
		profiles: data.profiles.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile)),
	};
}

export interface DeleteAgentProfileResult {
	next: RuntimeAgentProfilesData;
	removed: RuntimeAgentProfileRecord;
}

/**
 * Remove a profile, returning the new data and the removed entry. If the removed
 * profile was its agent's selection, that selection is cleared. Throws if missing.
 */
export function deleteAgentProfile(data: RuntimeAgentProfilesData, id: string): DeleteAgentProfileResult {
	const removed = data.profiles.find((profile) => profile.id === id);
	if (!removed) {
		throw new Error(`Agent profile "${id}" not found.`);
	}
	const selectedByAgent = { ...data.selectedByAgent };
	if (selectedByAgent[removed.agentId] === id) {
		delete selectedByAgent[removed.agentId];
	}
	return {
		next: { profiles: data.profiles.filter((profile) => profile.id !== id), selectedByAgent },
		removed,
	};
}

/**
 * Set (or clear, when `profileId` is null) the selected profile for an agent. Throws
 * if the target profile does not exist or belongs to a different agent.
 */
export function selectAgentProfile(
	data: RuntimeAgentProfilesData,
	agentId: RuntimeAgentId,
	profileId: string | null,
): RuntimeAgentProfilesData {
	const selectedByAgent = { ...data.selectedByAgent };
	if (profileId === null) {
		delete selectedByAgent[agentId];
		return { ...data, selectedByAgent };
	}
	const target = data.profiles.find((profile) => profile.id === profileId);
	if (!target) {
		throw new Error(`Agent profile "${profileId}" not found.`);
	}
	if (target.agentId !== agentId) {
		throw new Error(`Agent profile "${profileId}" belongs to agent "${target.agentId}", not "${agentId}".`);
	}
	selectedByAgent[agentId] = profileId;
	return { ...data, selectedByAgent };
}

/** Resolve the currently selected profile for an agent, or null if none/dangling. */
export function getSelectedAgentProfile(
	data: RuntimeAgentProfilesData,
	agentId: RuntimeAgentId,
): RuntimeAgentProfileRecord | null {
	const selectedId = data.selectedByAgent[agentId];
	if (!selectedId) {
		return null;
	}
	return data.profiles.find((profile) => profile.id === selectedId) ?? null;
}
