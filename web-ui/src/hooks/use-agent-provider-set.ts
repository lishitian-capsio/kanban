// Loads one agent's registered provider set (the named providers + the default)
// from `listAgentProviders`. This is a read-only, select-only view: defining,
// editing, and setting the default all live in Settings → Agent. The composer's
// session provider switch consumes this to list pickable providers and to know
// which one is the agent default.
import { useCallback, useEffect, useState } from "react";

import { fetchAgentProviderSets } from "@/runtime/runtime-config-query";
import type { RuntimeAgentProviderConfig } from "@/runtime/types";

export interface UseAgentProviderSetOptions {
	workspaceId: string | null;
	agentId: string | null;
	enabled?: boolean;
}

export interface UseAgentProviderSetResult {
	/** The agent's registered providers (secrets already redacted server-side). */
	providers: RuntimeAgentProviderConfig[];
	/** The agent's default provider id (its provider name), or null when none. */
	defaultProviderId: string | null;
	isLoading: boolean;
	reload: () => void;
}

/** The provider id used to address a provider within an agent (its provider name). */
export function providerIdOfConfig(config: RuntimeAgentProviderConfig): string {
	return (config.provider ?? "").trim();
}

export function useAgentProviderSet({
	workspaceId,
	agentId,
	enabled = true,
}: UseAgentProviderSetOptions): UseAgentProviderSetResult {
	const [providers, setProviders] = useState<RuntimeAgentProviderConfig[]>([]);
	const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const active = enabled && agentId !== null;

	const load = useCallback(async () => {
		if (!active || agentId === null) {
			setProviders([]);
			setDefaultProviderId(null);
			return;
		}
		setIsLoading(true);
		try {
			const response = await fetchAgentProviderSets(workspaceId);
			const set = response.agents[agentId] ?? null;
			setProviders(set?.providers ?? []);
			setDefaultProviderId(set?.defaultProviderId?.trim() || null);
		} catch {
			setProviders([]);
			setDefaultProviderId(null);
		} finally {
			setIsLoading(false);
		}
	}, [active, agentId, workspaceId]);

	useEffect(() => {
		void load();
	}, [load]);

	return { providers, defaultProviderId, isLoading, reload: () => void load() };
}
