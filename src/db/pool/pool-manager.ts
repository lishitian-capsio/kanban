import { createLogger } from "../../logging";
import type { DatabaseDriver } from "../driver/driver";
import { createDriver as defaultCreateDriver } from "../driver/driver-registry";
import type { ConnectionConfig } from "../types";

const log = createLogger("db:pool-manager");

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface PoolEntry {
	driver: DatabaseDriver;
	lastUsedAt: number;
}

export interface PoolManagerOptions {
	/** Evict + disconnect drivers idle longer than this. Default 5 minutes. */
	idleTimeoutMs?: number;
	/** Injectable clock (ms). Defaults to Date.now. Tests inject a fake. */
	now?: () => number;
	/** Injectable driver factory. Defaults to the engine registry. Tests inject a fake. */
	createDriver?: (config: ConnectionConfig) => DatabaseDriver;
}

/**
 * Process-level manager of one live {@link DatabaseDriver} per connection id. Connects
 * lazily on first use, reuses the driver across queries, de-dupes concurrent first-use,
 * and reclaims idle drivers. Never one-connection-per-query.
 */
export class PoolManager {
	private readonly entries = new Map<string, PoolEntry>();
	private readonly pending = new Map<string, Promise<DatabaseDriver>>();
	private readonly idleTimeoutMs: number;
	private readonly now: () => number;
	private readonly createDriver: (config: ConnectionConfig) => DatabaseDriver;

	constructor(options: PoolManagerOptions = {}) {
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.now = options.now ?? Date.now;
		this.createDriver = options.createDriver ?? defaultCreateDriver;
	}

	/** Get (or lazily create + connect) the driver for a connection id. */
	async getDriver(connId: string, config: ConnectionConfig): Promise<DatabaseDriver> {
		const existing = this.entries.get(connId);
		if (existing) {
			existing.lastUsedAt = this.now();
			return existing.driver;
		}
		const inFlight = this.pending.get(connId);
		if (inFlight) {
			return inFlight;
		}
		const promise = (async () => {
			const driver = this.createDriver(config);
			await driver.connect();
			this.entries.set(connId, { driver, lastUsedAt: this.now() });
			return driver;
		})();
		this.pending.set(connId, promise);
		try {
			return await promise;
		} finally {
			this.pending.delete(connId);
		}
	}

	/** Disconnect + drop the driver for a connection id (call after a registry edit/delete). */
	async invalidate(connId: string): Promise<void> {
		const entry = this.entries.get(connId);
		if (!entry) {
			return;
		}
		this.entries.delete(connId);
		await this.safeDisconnect(connId, entry.driver);
	}

	/** Evict + disconnect drivers idle past the timeout. */
	async reapIdle(): Promise<void> {
		const cutoff = this.now() - this.idleTimeoutMs;
		const stale = [...this.entries.entries()].filter(([, entry]) => entry.lastUsedAt < cutoff);
		for (const [connId, entry] of stale) {
			this.entries.delete(connId);
			await this.safeDisconnect(connId, entry.driver);
		}
	}

	/** Disconnect + drop every driver (runtime shutdown). */
	async disposeAll(): Promise<void> {
		const all = [...this.entries.entries()];
		this.entries.clear();
		for (const [connId, entry] of all) {
			await this.safeDisconnect(connId, entry.driver);
		}
	}

	size(): number {
		return this.entries.size;
	}

	private async safeDisconnect(connId: string, driver: DatabaseDriver): Promise<void> {
		try {
			await driver.disconnect();
		} catch (error) {
			log.warn("driver disconnect failed", { connId, error });
		}
	}
}
