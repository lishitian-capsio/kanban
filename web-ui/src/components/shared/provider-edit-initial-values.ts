import type { ProviderProtocol } from "@runtime-provider-protocol";
import type { RuntimeAgentProviderConfig } from "@/runtime/types";
import type { KanbanProviderDialogInitialValues } from "./kanban-add-provider-dialog";

/**
 * Build the edit dialog's initial values straight from a *per-agent* provider
 * config (the agent-scoped, redacted `listAgentProviders` entry).
 *
 * This must NOT be sourced from the global, name-keyed provider catalog: that
 * catalog collapses providers sharing a name across agents into one entry
 * (last-write-wins), so editing agent A's provider could show agent B's base
 * URL / model / key preview — or an empty key when B has none. The per-agent
 * config is the single source of truth for what the form should echo back.
 */
export function buildProviderEditInitialValues(
	provider: RuntimeAgentProviderConfig,
): KanbanProviderDialogInitialValues {
	const providerId = provider.provider ?? "";
	const protocolConfigs = provider.protocols?.map((entry) => ({
		protocol: entry.protocol as ProviderProtocol,
		baseUrl: entry.baseUrl,
	}));
	return {
		providerId,
		name: providerId,
		baseUrl: provider.baseUrl ?? protocolConfigs?.[0]?.baseUrl ?? "",
		defaultModelId: provider.model ?? "",
		protocols: protocolConfigs?.map((entry) => entry.protocol),
		protocolConfigs,
		models: provider.models ?? [],
		modelsSourceUrl: provider.modelsSourceUrl ?? "",
		anthropic: provider.anthropic,
		apiKeyPreview: provider.apiKeyPreview,
		headers: provider.headers,
		timeoutMs: provider.timeout ?? null,
	};
}
