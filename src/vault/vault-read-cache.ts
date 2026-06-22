import type { RuntimeVaultDocument } from "../core/api-contract";

/** Result of an expensive vault scan: the parsed documents plus the fs signature observed. */
export interface VaultScanResult {
	documents: RuntimeVaultDocument[];
	signature: string;
}

export interface VaultReadCacheReadOptions {
	/**
	 * Cheap fs probe (directory listing + `stat`, **no file contents read**) yielding
	 * a signature string. Run on a warm cache to decide whether a re-scan is needed.
	 */
	computeSignature: () => Promise<string>;
	/**
	 * Expensive scan (directory listing + `readFile` + parse of every document) used
	 * only on a cache miss. Returns the documents and the signature they correspond to.
	 */
	scan: () => Promise<VaultScanResult>;
}

export interface VaultReadResult {
	/** Bumps on every re-scan; derived structures key off it to know when to rebuild. */
	version: number;
	documents: RuntimeVaultDocument[];
}

interface CacheState {
	signature: string;
	version: number;
	documents: RuntimeVaultDocument[];
}

/**
 * Caches a single vault's fully-parsed document list so the by-keystroke read paths
 * (autocomplete, search, link graph) stop re-reading and re-parsing every `.md` on
 * disk per call. One cache backs all read consumers of a workspace, keyed by the
 * vault's docs directory ({@link getVaultReadCache}).
 *
 * Freshness is reconciled two ways so the cache never serves stale data even when
 * the vault is mutated out of process (a CLI `vault doc` write, a git pull on the
 * board branch, a hand edit):
 *  - a cheap fs **signature** (listing + `mtime`/`size` per file) gates every warm
 *    read — when it differs from the cached one, the expensive scan re-runs;
 *  - {@link invalidate} forces the next read to re-scan unconditionally, called by
 *    the store after its own mutations so an in-process write is seen immediately
 *    even in the pathological same-millisecond / same-size case the signature can
 *    miss.
 */
export class VaultReadCache {
	private state: CacheState | null = null;
	private dirty = false;
	private readonly derived = new Map<string, { version: number; value: unknown }>();

	async read(options: VaultReadCacheReadOptions): Promise<VaultReadResult> {
		if (!this.dirty && this.state) {
			const signature = await options.computeSignature();
			if (signature === this.state.signature) {
				return { version: this.state.version, documents: this.state.documents };
			}
		}

		const { documents, signature } = await options.scan();
		const version = (this.state?.version ?? 0) + 1;
		this.state = { signature, version, documents };
		this.dirty = false;
		return { version, documents };
	}

	/** Force the next {@link read} to re-scan, skipping the signature probe. */
	invalidate(): void {
		this.dirty = true;
	}

	/**
	 * Memoize a structure derived from the cached documents (e.g. the link index),
	 * rebuilding it only when `version` advances. Returns the same reference for
	 * repeated calls at one version so consumers share the work.
	 */
	derive<T>(name: string, version: number, build: () => T): T {
		const existing = this.derived.get(name);
		if (existing && existing.version === version) {
			return existing.value as T;
		}
		const value = build();
		this.derived.set(name, { version, value });
		return value;
	}
}

const cachesByKey = new Map<string, VaultReadCache>();

/** Process-wide cache for one vault, keyed by its docs directory (per-workspace isolation). */
export function getVaultReadCache(key: string): VaultReadCache {
	let cache = cachesByKey.get(key);
	if (!cache) {
		cache = new VaultReadCache();
		cachesByKey.set(key, cache);
	}
	return cache;
}
