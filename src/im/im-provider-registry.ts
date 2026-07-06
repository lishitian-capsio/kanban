/**
 * Platform-keyed registry of {@link ImProvider} adapters — the single extension point for adding
 * an IM platform, mirroring the DB driver registry (`src/db/driver/driver-registry.ts`) and the
 * host-keyed git credential injector (`src/workspace/git-utils.ts`). A concrete adapter registers
 * itself by its own {@link ImPlatform} id; callers resolve an adapter by platform.
 */
import { UnsupportedImPlatformError } from "./errors";
import type { ImProvider } from "./im-provider";
import type { ImPlatform } from "./types";

const registry = new Map<ImPlatform, ImProvider>();

/** Register (or replace) the adapter for its platform. Last registration wins. */
export function registerImProvider(provider: ImProvider): void {
	registry.set(provider.platform, provider);
}

/** Remove the adapter for a platform. No-op when none is registered. */
export function unregisterImProvider(platform: ImPlatform): void {
	registry.delete(platform);
}

/** The adapter for a platform, or `null` when none is registered. */
export function getImProvider(platform: ImPlatform): ImProvider | null {
	return registry.get(platform) ?? null;
}

/** The adapter for a platform. Throws {@link UnsupportedImPlatformError} when none is registered. */
export function requireImProvider(platform: ImPlatform): ImProvider {
	const provider = registry.get(platform);
	if (!provider) {
		throw new UnsupportedImPlatformError(platform);
	}
	return provider;
}

/** The platform ids that currently have a registered adapter. */
export function listRegisteredImPlatforms(): ImPlatform[] {
	return [...registry.keys()];
}
