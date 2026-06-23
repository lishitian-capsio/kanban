import { UnsupportedEngineError } from "../errors";
import type { ConnectionConfig, DatabaseEngine } from "../types";
import type { DatabaseDriver } from "./driver";

export type DriverFactory = (config: ConnectionConfig) => DatabaseDriver;

const registry = new Map<DatabaseEngine, DriverFactory>();

/** Register a driver factory for an engine. The single extension point for new engines. */
export function registerDriver(engine: DatabaseEngine, factory: DriverFactory): void {
	registry.set(engine, factory);
}

/** Build a driver for the config's engine. Throws {@link UnsupportedEngineError} if none registered. */
export function createDriver(config: ConnectionConfig): DatabaseDriver {
	const factory = registry.get(config.engine);
	if (!factory) {
		throw new UnsupportedEngineError(config.engine);
	}
	return factory(config);
}
