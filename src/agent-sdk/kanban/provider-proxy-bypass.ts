// Per-provider "direct connection (bypass proxy)" host collection.
//
// The runtime's outbound-proxy decision is made PER HOST, not per provider —
// the in-process fetch interceptor (config/proxy-fetch.ts) and the CLI-agent
// network bridge (unified-proxy/network-bridge.ts) only ever see a request's
// URL/host, never which provider config originated it. So a per-provider
// bypass is realized by folding the provider's endpoint host into the effective
// NO_PROXY set carried by the proxy holder.
//
// DESIGN TRADE-OFF (not a bug): because the decision is host-keyed, if two
// providers share the same host, marking one `bypassProxy` makes the WHOLE host
// go direct — there is no way to route one provider on that host through the
// proxy while another bypasses it. NO_PROXY has no per-provider granularity.
//
// This module is pure (host extraction + set walk) so it is unit-testable
// without touching disk or the live holder; the runtime accessor that reads the
// persisted provider store lives in agent-provider-config.ts.

import { extractHostname } from "../../config/proxy-env";
import type { AgentProviderSet } from "./agent-provider-config";

/**
 * Resolve a provider config's endpoint host for NO_PROXY purposes. The single
 * source of truth for the endpoint is `protocols[0].baseUrl`; the legacy scalar
 * `baseUrl` mirror is consulted only as a fallback. Returns `null` when neither
 * yields a recoverable host (e.g. a vendor-native provider with no base URL).
 */
function providerBypassHost(provider: AgentProviderSet["providers"][number]): string | null {
	if (provider.bypassProxy !== true) return null;
	const endpoint = provider.protocols?.[0]?.baseUrl ?? provider.baseUrl;
	return extractHostname(endpoint);
}

/**
 * Collect the de-duplicated set of endpoint hosts that should bypass the
 * outbound proxy, gathered from every provider (across all agents) whose
 * `bypassProxy` flag is set. Hosts are lowercased and de-duplicated so the
 * result merges cleanly into the NO_PROXY list. Order follows first
 * appearance for stable output.
 */
export function collectProviderBypassHosts(sets: Record<string, AgentProviderSet>): string[] {
	const hosts = new Set<string>();
	for (const set of Object.values(sets)) {
		for (const provider of set.providers) {
			const host = providerBypassHost(provider);
			if (host) hosts.add(host.toLowerCase());
		}
	}
	return [...hosts];
}
