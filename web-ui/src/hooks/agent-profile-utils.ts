// Pure helpers for the agent-profile control: selection resolution and the
// name generation used by "New" / "Duplicate". Kept side-effect free so the
// hook and components can stay thin and these stay unit-testable.
import type { RuntimeAgentId, RuntimeAgentProfile, RuntimeAgentProfileCreateRequest } from "@/runtime/types";

const NEW_PROFILE_BASE_NAME = "New profile";

/** Resolves the agent's currently selected profile, tolerating dangling/foreign ids. */
export function selectProfileForAgent(
	profiles: readonly RuntimeAgentProfile[],
	selectedByAgent: Readonly<Record<string, string>>,
	agentId: RuntimeAgentId,
): RuntimeAgentProfile | null {
	const selectedId = selectedByAgent[agentId];
	if (!selectedId) {
		return null;
	}
	return profiles.find((candidate) => candidate.id === selectedId && candidate.agentId === agentId) ?? null;
}

function isNameTaken(existingNames: readonly string[], candidate: string): boolean {
	const normalized = candidate.trim().toLowerCase();
	return existingNames.some((name) => name.trim().toLowerCase() === normalized);
}

/** "Fast" -> "Fast (copy)" -> "Fast (copy 2)" -> ... avoiding case-insensitive clashes. */
export function buildCopyProfileName(existingNames: readonly string[], sourceName: string): string {
	const base = sourceName.trim();
	const first = `${base} (copy)`;
	if (!isNameTaken(existingNames, first)) {
		return first;
	}
	for (let counter = 2; ; counter += 1) {
		const candidate = `${base} (copy ${counter})`;
		if (!isNameTaken(existingNames, candidate)) {
			return candidate;
		}
	}
}

/** "New profile" -> "New profile 2" -> ... for the create-from-scratch flow. */
export function buildNewProfileName(existingNames: readonly string[]): string {
	if (!isNameTaken(existingNames, NEW_PROFILE_BASE_NAME)) {
		return NEW_PROFILE_BASE_NAME;
	}
	for (let counter = 2; ; counter += 1) {
		const candidate = `${NEW_PROFILE_BASE_NAME} ${counter}`;
		if (!isNameTaken(existingNames, candidate)) {
			return candidate;
		}
	}
}

/**
 * Builds the create payload for duplicating a profile. Profiles are reference-only
 * records (no credentials), so the duplicate copies only the provider/model selection.
 */
export function duplicateProfileCreateInput(
	source: RuntimeAgentProfile,
	name: string,
): RuntimeAgentProfileCreateRequest {
	return {
		agentId: source.agentId,
		name,
		providerId: source.providerId,
		modelId: source.modelId,
		reasoningEffort: source.reasoningEffort,
		select: true,
	};
}
