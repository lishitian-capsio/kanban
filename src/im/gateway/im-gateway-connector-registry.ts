/**
 * Platform-keyed registry of inbound {@link ImGatewayConnector} adapters — the single extension
 * point for adding an IM long-connection, mirroring the outbound provider registry
 * (`../im-provider-registry.ts`) and the DB driver / host-keyed git credential registries. A
 * concrete adapter registers itself by its own {@link ImPlatform} id at startup (like
 * `registerLarkImProvider`); the resident {@link ImGateway} reads this registry to decide which
 * platforms to bring up.
 */

import type { ImPlatform } from "../types";
import type { ImGatewayConnector } from "./im-gateway-connector";

const registry = new Map<ImPlatform, ImGatewayConnector>();

/** Register (or replace) the inbound connector for its platform. Last registration wins. */
export function registerImGatewayConnector(connector: ImGatewayConnector): void {
	registry.set(connector.platform, connector);
}

/** Remove the inbound connector for a platform. No-op when none is registered. */
export function unregisterImGatewayConnector(platform: ImPlatform): void {
	registry.delete(platform);
}

/** The inbound connector for a platform, or `null` when none is registered. */
export function getImGatewayConnector(platform: ImPlatform): ImGatewayConnector | null {
	return registry.get(platform) ?? null;
}

/** The platform ids that currently have a registered inbound connector. */
export function listRegisteredImGatewayConnectorPlatforms(): ImPlatform[] {
	return [...registry.keys()];
}
