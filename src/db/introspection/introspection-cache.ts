// Process-level cache for lazy schema introspection.
//
// Expanding a metadata tree (schemas → tables → table detail) is read-heavy and
// repetitive: a UI re-renders the tree, an agent re-walks it, a CLI lists it
// again — each call would otherwise re-issue catalog queries against the DB.
// This cache memoizes every level so a re-expansion of an unchanged database
// performs no round-trip.
//
// Freshness follows the same 套路 as the vault read cache and the session merge
// cache — a cheap signature gates warm hits, and an explicit `invalidate` forces
// a reload — but specialized two ways for databases:
//   - a per-connection in-process **mutation generation** (bumped by the service
//     after a write/DDL succeeds, and on connection invalidation) is folded into
//     every entry's signature, so an in-process schema change is seen at once;
//   - a driver-supplied **data signature** (SQLite: the db file's mtime+size;
//     remote engines: a constant) covers out-of-process changes the generation
//     cannot — a hand edit of a SQLite file, for instance.
// An entry is reused only when both parts match the value cached for that key.

interface CacheEntry {
	signature: string;
	value: unknown;
}

interface ConnectionCache {
	/** Bumped by {@link IntrospectionCache.invalidate}; part of every entry's signature. */
	generation: number;
	entries: Map<string, CacheEntry>;
}

export class IntrospectionCache {
	private readonly byConnection = new Map<string, ConnectionCache>();

	private connection(connId: string): ConnectionCache {
		let conn = this.byConnection.get(connId);
		if (!conn) {
			conn = { generation: 0, entries: new Map() };
			this.byConnection.set(connId, conn);
		}
		return conn;
	}

	/**
	 * Return the cached value for `(connId, key)`, reloading via `load` only when
	 * the combined signature (mutation generation + the `computeDataSignature`
	 * probe) differs from the cached one. `computeDataSignature` runs on every
	 * call — keep it cheap (a `stat`, not a scan).
	 */
	async read<T>(
		connId: string,
		key: string,
		computeDataSignature: () => Promise<string>,
		load: () => Promise<T>,
	): Promise<T> {
		const conn = this.connection(connId);
		const dataSignature = await computeDataSignature();
		const signature = `${conn.generation}:${dataSignature}`;
		const existing = conn.entries.get(key);
		if (existing && existing.signature === signature) {
			return existing.value as T;
		}
		const value = await load();
		conn.entries.set(key, { signature, value });
		return value;
	}

	/**
	 * Force every cached level of a connection to reload on its next read. Called
	 * by the service after a write/DDL statement (which may have changed the
	 * schema) and when a connection's pool driver is invalidated.
	 */
	invalidate(connId: string): void {
		const conn = this.byConnection.get(connId);
		if (!conn) {
			return;
		}
		conn.generation += 1;
		conn.entries.clear();
	}
}

let sharedCache: IntrospectionCache | null = null;

/** The process-wide cache shared by all introspection consumers in this runtime. */
export function getIntrospectionCache(): IntrospectionCache {
	if (!sharedCache) {
		sharedCache = new IntrospectionCache();
	}
	return sharedCache;
}
