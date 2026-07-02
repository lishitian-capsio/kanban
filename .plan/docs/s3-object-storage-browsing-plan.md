# S3 Object Storage Read-Only Browsing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, S3-compatible object-storage browser as a dedicated "Storage" surface (peer overlay to Vault/Database/GitHistory), built on Bun's native `Bun.S3Client`.

**Architecture:** A new `src/storage/` backend mirrors `src/db/` (connection records + machine-home secrets + an injectable client factory + a service). A `workspace-storage` tRPC router (caller = human) is scoped per workspace. The web-ui `components/storage/` surface reuses file-surface presentation (CodeMirror viewer, binary preview, icons) with a connection sidebar patterned on the Database view. Read-only is structural — the service exposes no write/delete/presign method.

**Tech Stack:** Bun `S3Client` (`node_modules/bun-types/s3.d.ts`), zod, tRPC, React + Tailwind, CodeMirror 6, vitest (Node, with an injected fake S3 client).

## Global Constraints

- **Runtime is Bun-only.** Reference `Bun.S3Client` LAZILY via the global inside the default factory (never a top-level `import { S3Client } from "bun"` — that would break vitest import on Node). Type-only imports from `"bun"` (`import type { S3Options, ... } from "bun"`) are fine.
- **No `any`.** No inline/dynamic imports. Prefer SDK-provided types.
- **Credentials are explicit, never env-derived.** Always pass `accessKeyId`/`secretAccessKey`/`endpoint`/`region`/`bucket` per connection; never rely on Bun's `S3_*`/`AWS_*` env fallback. v1 requires credentials.
- **Secrets never committed, never in `--json`, 0600.** Machine-home `~/.kanban/settings/storage-credentials.json` only.
- **Read-only v1.** No list-buckets, no write/delete/upload, no presign (upload or download-to-browser). Downloads stream bytes through the backend.
- **Logging** via `createLogger("storage:...")`; no `console.*`.
- **Caps:** text 1 MB, binary preview 8 MB, download 100 MB (mirror `workspace-fs-api.ts` semantics).
- **Never commit** unless the user asks.
- **Tests run under** `bun vitest run <path>` locally / `npx vitest run` on CI; both must pass with the injected fake (no real Bun.s3).

---

### Task 1: Connection record + credential schemas

**Files:**
- Create: `src/storage/storage-connection-record.ts`
- Test: `test/runtime/storage/storage-connection-record.test.ts`

**Interfaces:**
- Produces: `storageConnectionRecordSchema`, `StorageConnectionRecord`, `storageCredentialSchema`, `StorageCredential`, `storageCredentialsDataSchema`, `StorageCredentialsData`.

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/storage-connection-record.test.ts
import { describe, expect, it } from "vitest";
import {
	storageConnectionRecordSchema,
	storageCredentialSchema,
} from "../../../src/storage/storage-connection-record";

describe("storageConnectionRecordSchema", () => {
	it("defaults virtualHostedStyle to false and keeps nullable metadata", () => {
		const record = storageConnectionRecordSchema.parse({
			connId: "r2-prod",
			label: "R2 prod",
			endpoint: "https://acct.r2.cloudflarestorage.com",
			region: null,
			bucket: "assets",
			createdAt: "2026-07-02T00:00:00.000Z",
		});
		expect(record.virtualHostedStyle).toBe(false);
		expect(record.region).toBeNull();
		expect(record.bucket).toBe("assets");
	});

	it("rejects an empty bucket", () => {
		expect(() =>
			storageConnectionRecordSchema.parse({
				connId: "x",
				label: "x",
				endpoint: null,
				region: null,
				bucket: "",
				createdAt: "2026-07-02T00:00:00.000Z",
			}),
		).toThrow();
	});

	it("parses a credential with optional session token", () => {
		const cred = storageCredentialSchema.parse({ accessKeyId: "AK", secretAccessKey: "SK" });
		expect(cred.sessionToken).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/storage/storage-connection-record.test.ts`
Expected: FAIL — cannot resolve `../../../src/storage/storage-connection-record`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/storage/storage-connection-record.ts
import { z } from "zod";

/**
 * Committed, secret-free connection metadata. Sharded one-file-per-`connId` under the
 * board-data home so cross-branch edits never collide. NEVER carries credentials.
 * A connection is scoped to ONE bucket — `Bun.S3Client` is bucket-scoped and exposes no
 * ListBuckets, so we do not enumerate buckets.
 */
export const storageConnectionRecordSchema = z.object({
	connId: z.string().min(1),
	label: z.string().min(1),
	/** Custom S3-compatible endpoint (R2/MinIO/Spaces/Supabase); null ⇒ AWS default. */
	endpoint: z.string().nullable(),
	region: z.string().nullable(),
	bucket: z.string().min(1),
	/** false ⇒ path-style addressing (MinIO); true ⇒ virtual-hosted. Default false. */
	virtualHostedStyle: z.boolean().default(false),
	/** ISO timestamp; supplied by the caller (no Date.now() in stored/pure code). */
	createdAt: z.string(),
});
export type StorageConnectionRecord = z.infer<typeof storageConnectionRecordSchema>;

/** Machine-home secret for one connection. Lives ONLY in ~/.kanban, never committed. */
export const storageCredentialSchema = z.object({
	accessKeyId: z.string().optional(),
	secretAccessKey: z.string().optional(),
	sessionToken: z.string().optional(),
});
export type StorageCredential = z.infer<typeof storageCredentialSchema>;

export const storageCredentialsDataSchema = z.object({
	credentials: z.record(z.string(), storageCredentialSchema).default({}),
});
export type StorageCredentialsData = z.infer<typeof storageCredentialsDataSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/storage/storage-connection-record.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/storage-connection-record.ts test/runtime/storage/storage-connection-record.test.ts
git commit -m "feat(storage): S3 connection record + credential schemas"
```

---

### Task 2: Connection store (shards + machine-home secrets + option resolution)

**Files:**
- Create: `src/storage/storage-connection-store.ts`
- Test: `test/runtime/storage/storage-connection-store.test.ts`

**Interfaces:**
- Consumes: schemas from Task 1; `readShardDir`/`writeShardDir` (`src/state/sharded-json-store.ts`); `lockedFileSystem` (`src/fs/locked-file-system.ts`).
- Produces:
  - `normalizeConnId(id: string): string`
  - `readStorageConnections(shardDir: string): Promise<StorageConnectionRecord[]>`
  - `writeStorageConnections(shardDir: string, records: StorageConnectionRecord[]): Promise<void>`
  - `readStorageCredentials(path: string): Promise<StorageCredentialsData>`
  - `writeStorageCredentials(path: string, data: StorageCredentialsData): Promise<void>`
  - `resolveS3ClientOptions(record: StorageConnectionRecord, credential: StorageCredential | undefined): ResolvedS3ClientOptions`
  - type `ResolvedS3ClientOptions = { bucket: string; endpoint?: string; region?: string; virtualHostedStyle: boolean; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/storage-connection-store.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	normalizeConnId,
	readStorageConnections,
	readStorageCredentials,
	resolveS3ClientOptions,
	writeStorageConnections,
	writeStorageCredentials,
} from "../../../src/storage/storage-connection-store";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kanban-storage-store-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("storage connection store", () => {
	it("roundtrips sharded records and canonicalizes connId", async () => {
		const shardDir = join(dir, "storage-connections");
		await writeStorageConnections(shardDir, [
			{
				connId: "R2-Prod",
				label: "R2",
				endpoint: null,
				region: "auto",
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
		]);
		const records = await readStorageConnections(shardDir);
		expect(records).toHaveLength(1);
		expect(records[0]?.connId).toBe("r2-prod");
	});

	it("treats a missing credentials file as empty", async () => {
		const data = await readStorageCredentials(join(dir, "missing.json"));
		expect(data.credentials).toEqual({});
	});

	it("roundtrips credentials", async () => {
		const path = join(dir, "storage-credentials.json");
		await writeStorageCredentials(path, {
			credentials: { "r2-prod": { accessKeyId: "AK", secretAccessKey: "SK" } },
		});
		const data = await readStorageCredentials(path);
		expect(data.credentials["r2-prod"]?.secretAccessKey).toBe("SK");
	});

	it("merges record + secret into explicit client options", () => {
		const opts = resolveS3ClientOptions(
			{
				connId: "r2-prod",
				label: "R2",
				endpoint: "https://acct.r2.cloudflarestorage.com",
				region: null,
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
			{ accessKeyId: "AK", secretAccessKey: "SK" },
		);
		expect(opts).toMatchObject({
			bucket: "assets",
			endpoint: "https://acct.r2.cloudflarestorage.com",
			accessKeyId: "AK",
			secretAccessKey: "SK",
			virtualHostedStyle: false,
		});
		expect(opts.region).toBeUndefined();
	});

	it("normalizes ids by trim + lowercase", () => {
		expect(normalizeConnId("  R2-Prod ")).toBe("r2-prod");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/storage/storage-connection-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (mirror `src/db/registry/connection-store.ts`)

```ts
// src/storage/storage-connection-store.ts
import { readFile } from "node:fs/promises";

import { createLogger } from "../logging";
import { lockedFileSystem } from "../fs/locked-file-system";
import { readShardDir, writeShardDir } from "../state/sharded-json-store";
import {
	type StorageConnectionRecord,
	type StorageCredential,
	type StorageCredentialsData,
	storageConnectionRecordSchema,
	storageCredentialsDataSchema,
} from "./storage-connection-record";

export type {
	StorageConnectionRecord,
	StorageCredential,
	StorageCredentialsData,
} from "./storage-connection-record";

const log = createLogger("storage:connection-store");

/** Fully-resolved, explicit options for constructing a bucket-scoped S3 client. */
export interface ResolvedS3ClientOptions {
	bucket: string;
	endpoint?: string;
	region?: string;
	virtualHostedStyle: boolean;
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
}

/** The id used to address a connection (its normalized id) — also the shard filename. */
export function normalizeConnId(id: string): string {
	return id.trim().toLowerCase();
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read + assemble all committed connection records from their per-id shards. */
export async function readStorageConnections(shardDir: string): Promise<StorageConnectionRecord[]> {
	const shardMap = await readShardDir(shardDir, storageConnectionRecordSchema);
	return [...shardMap.values()];
}

/** Persist connection records: one shard per canonical `connId`. Absent shards are deleted. */
export async function writeStorageConnections(shardDir: string, records: StorageConnectionRecord[]): Promise<void> {
	const shardMap = new Map<string, StorageConnectionRecord>(
		records.map((r) => {
			const id = normalizeConnId(r.connId);
			return [id, { ...r, connId: id }];
		}),
	);
	await writeShardDir(shardDir, shardMap);
}

/** Read the machine-home credentials file. Missing/torn file ⇒ empty credentials. */
export async function readStorageCredentials(path: string): Promise<StorageCredentialsData> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = storageCredentialsDataSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : { credentials: {} };
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			log.warn("failed to read storage credentials file; treating as empty", { error });
		}
		return { credentials: {} };
	}
}

/** Persist the machine-home credentials file (machine-local; no repo lock). */
export async function writeStorageCredentials(path: string, data: StorageCredentialsData): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, data, { lock: null });
}

/**
 * Merge committed metadata + the machine-home secret into explicit S3 client options.
 * The secret exists only in the returned in-memory object — it is never written to committed data,
 * and we always pass explicit values so Bun never falls back to `S3_*`/`AWS_*` env vars.
 */
export function resolveS3ClientOptions(
	record: StorageConnectionRecord,
	credential: StorageCredential | undefined,
): ResolvedS3ClientOptions {
	return {
		bucket: record.bucket,
		endpoint: record.endpoint ?? undefined,
		region: record.region ?? undefined,
		virtualHostedStyle: record.virtualHostedStyle,
		accessKeyId: credential?.accessKeyId,
		secretAccessKey: credential?.secretAccessKey,
		sessionToken: credential?.sessionToken,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun vitest run test/runtime/storage/storage-connection-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/storage-connection-store.ts test/runtime/storage/storage-connection-store.test.ts
git commit -m "feat(storage): sharded connection store + machine-home secrets"
```

---

### Task 3: Object-mapping + content-classification helpers (pure)

**Files:**
- Create: `src/storage/storage-object-mapping.ts`
- Test: `test/runtime/storage/storage-object-mapping.test.ts`

**Interfaces:**
- Consumes: `import type { S3ListObjectsResponse } from "bun"`.
- Produces:
  - `mapListResponse(prefix: string, res: S3ListObjectsResponse): { entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string }`
  - type `StorageEntry = { key: string; name: string; kind: "prefix" | "object"; size?: number; lastModified?: string; etag?: string }`
  - `basename(key: string): string` (last non-empty segment of a `/`-delimited key; trailing slash tolerated)
  - `isTextKey(key: string): boolean` (extension allowlist — the `.ts`→`video/mp2t` landmine)
  - `classifyContent(bytes: Uint8Array, contentType: string, key: string): { binary: boolean }` (NUL sniff on head + content-type + `isTextKey`)
  - `TEXT_EXTENSIONS: ReadonlySet<string>`

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/storage-object-mapping.test.ts
import { describe, expect, it } from "vitest";
import { basename, classifyContent, isTextKey, mapListResponse } from "../../../src/storage/storage-object-mapping";

describe("mapListResponse", () => {
	it("maps commonPrefixes to prefix entries and contents to object entries", () => {
		const out = mapListResponse("photos/", {
			commonPrefixes: [{ prefix: "photos/2026/" }],
			contents: [{ key: "photos/a.png", size: 1234, lastModified: "2026-07-02T00:00:00Z", eTag: "abc" }],
			isTruncated: true,
			nextContinuationToken: "TOKEN",
		});
		expect(out.entries).toEqual([
			{ key: "photos/2026/", name: "2026", kind: "prefix" },
			{ key: "photos/a.png", name: "a.png", kind: "object", size: 1234, lastModified: "2026-07-02T00:00:00Z", etag: "abc" },
		]);
		expect(out.isTruncated).toBe(true);
		expect(out.nextContinuationToken).toBe("TOKEN");
	});

	it("drops the folder placeholder object equal to the listing prefix", () => {
		const out = mapListResponse("photos/", {
			contents: [{ key: "photos/", size: 0 }],
			isTruncated: false,
		});
		expect(out.entries).toEqual([]);
	});
});

describe("basename", () => {
	it("returns the last segment, tolerating a trailing slash", () => {
		expect(basename("a/b/c.txt")).toBe("c.txt");
		expect(basename("a/b/")).toBe("b");
		expect(basename("root.txt")).toBe("root.txt");
	});
});

describe("classifyContent", () => {
	it("treats .ts as text despite its video mime", () => {
		expect(isTextKey("src/index.ts")).toBe(true);
		expect(classifyContent(new Uint8Array([0x61, 0x62]), "video/mp2t", "src/index.ts").binary).toBe(false);
	});
	it("flags NUL bytes as binary", () => {
		expect(classifyContent(new Uint8Array([0x00, 0x01]), "application/octet-stream", "blob.bin").binary).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun vitest run test/runtime/storage/storage-object-mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

> Copy the `TEXT_EXTENSIONS` set verbatim from `src/workspace/workspace-fs-api.ts` (lines ~85–190) to keep the two surfaces consistent. Below is the logic; paste the full extension set where indicated.

```ts
// src/storage/storage-object-mapping.ts
import type { S3ListObjectsResponse } from "bun";

export interface StorageEntry {
	key: string;
	name: string;
	kind: "prefix" | "object";
	size?: number;
	lastModified?: string;
	etag?: string;
}

/** Extension allowlist that overrides mime-db (fixes `.ts` → `video/mp2t`). Keep in sync with workspace-fs-api.ts. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	// PASTE the exact contents of TEXT_EXTENSIONS from src/workspace/workspace-fs-api.ts here:
	"ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "txt", "css", "scss",
	"html", "xml", "yml", "yaml", "toml", "ini", "sh", "bash", "zsh", "py", "rb", "go", "rs",
	"java", "c", "h", "cpp", "hpp", "cs", "php", "sql", "csv", "tsv", "log", "env", "gitignore",
	"dockerignore", "editorconfig", "lock", "svg",
	// ... ensure this matches workspace-fs-api.ts EXACTLY (superset is fine, drift is not).
]);

/** Last non-empty `/`-delimited segment; tolerates a single trailing slash (prefix keys). */
export function basename(key: string): string {
	const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function extensionOf(key: string): string {
	const name = basename(key);
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isTextKey(key: string): boolean {
	return TEXT_EXTENSIONS.has(extensionOf(key));
}

/**
 * Decide binary-ness: a NUL byte in the head is always binary; otherwise a text-ish content-type
 * OR a known text extension ⇒ text. Mirrors the fs sniffing contract.
 */
export function classifyContent(bytes: Uint8Array, contentType: string, key: string): { binary: boolean } {
	const head = bytes.subarray(0, 8192);
	for (const b of head) {
		if (b === 0) {
			return { binary: true };
		}
	}
	const type = contentType.toLowerCase();
	const looksTextByType = type.startsWith("text/") || type.includes("json") || type.includes("xml") || type.includes("javascript");
	return { binary: !(looksTextByType || isTextKey(key)) };
}

/** Convert a Bun `list()` response (delimiter "/") into ordered entries: folders first, then objects. */
export function mapListResponse(
	prefix: string,
	res: S3ListObjectsResponse,
): { entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string } {
	const prefixes: StorageEntry[] = (res.commonPrefixes ?? []).map((cp) => ({
		key: cp.prefix,
		name: basename(cp.prefix),
		kind: "prefix" as const,
	}));
	const objects: StorageEntry[] = (res.contents ?? [])
		// S3 returns a zero-byte placeholder object for the folder itself; drop it.
		.filter((c) => c.key !== prefix)
		.map((c) => ({
			key: c.key,
			name: basename(c.key),
			kind: "object" as const,
			size: c.size,
			lastModified: c.lastModified,
			etag: c.eTag,
		}));
	return {
		entries: [...prefixes, ...objects],
		isTruncated: res.isTruncated === true,
		nextContinuationToken: res.nextContinuationToken,
	};
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun vitest run test/runtime/storage/storage-object-mapping.test.ts` → PASS.

- [ ] **Step 5: Verify the TEXT_EXTENSIONS set matches**

Run: `grep -n "TEXT_EXTENSIONS" src/workspace/workspace-fs-api.ts` and diff the set contents by eye; the storage set must be a superset (any drift causes a `.ts`-style bug). Fix inline if needed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/storage-object-mapping.ts test/runtime/storage/storage-object-mapping.test.ts
git commit -m "feat(storage): pure object-mapping + content classification helpers"
```

---

### Task 4: S3 client injection seam (Bun-only factory, lazy global)

**Files:**
- Create: `src/storage/s3-client.ts`
- Test: `test/runtime/storage/s3-client.test.ts`

**Interfaces:**
- Consumes: `ResolvedS3ClientOptions` (Task 2); `import type { S3ListObjectsInput, S3ListObjectsResponse, S3Stats } from "bun"` (use the exact exported names — `S3ListObjectsOptions`, `S3ListObjectsResponse`, `S3Stats`).
- Produces:
  - interface `S3ClientLike { list(input: S3ListObjectsOptions): Promise<S3ListObjectsResponse>; stat(key: string): Promise<S3Stats>; readBytes(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; contentType: string }> }`
  - type `S3ClientFactory = (opts: ResolvedS3ClientOptions) => S3ClientLike`
  - `defaultS3ClientFactory: S3ClientFactory` (wraps `new Bun.S3Client(...)`, lazy global)

- [ ] **Step 1: Write the failing test** (only the seam contract — the default factory is Bun-only and not invoked)

```ts
// test/runtime/storage/s3-client.test.ts
import { describe, expect, it } from "vitest";
import type { S3ClientFactory, S3ClientLike } from "../../../src/storage/s3-client";
import { defaultS3ClientFactory } from "../../../src/storage/s3-client";

describe("s3-client seam", () => {
	it("exposes a default factory without importing Bun at module load", () => {
		// Importing the module must not throw on Node/vitest (Bun.S3Client referenced lazily).
		expect(typeof defaultS3ClientFactory).toBe("function");
	});

	it("a fake factory satisfies S3ClientLike", async () => {
		const fake: S3ClientFactory = () =>
			({
				async list() {
					return { contents: [], isTruncated: false };
				},
				async stat() {
					return { size: 0, lastModified: new Date(0), etag: "e", type: "text/plain" };
				},
				async readBytes() {
					return { bytes: new Uint8Array(), truncated: false, contentType: "text/plain" };
				},
			}) satisfies S3ClientLike;
		const client = fake({ bucket: "b", virtualHostedStyle: false });
		expect((await client.list({})).isTruncated).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun vitest run test/runtime/storage/s3-client.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation** (mirror `src/db/driver/bun-sql/bun-sql.ts:40`)

```ts
// src/storage/s3-client.ts
import type { S3ListObjectsOptions, S3ListObjectsResponse, S3Stats } from "bun";

import type { ResolvedS3ClientOptions } from "./storage-connection-store";

/** The minimal `Bun.S3Client` surface this subsystem uses — lets tests inject a fake under vitest. */
export interface S3ClientLike {
	list(input: S3ListObjectsOptions): Promise<S3ListObjectsResponse>;
	stat(key: string): Promise<S3Stats>;
	/** Read at most `maxBytes` of an object via an HTTP Range slice (never downloads more than the cap). */
	readBytes(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; contentType: string }>;
}

export type S3ClientFactory = (opts: ResolvedS3ClientOptions) => S3ClientLike;

/**
 * Default factory: the real Bun-native S3 client. `Bun.S3Client` is referenced LAZILY via the `Bun`
 * global so this module stays importable under Node/vitest, where tests inject a fake and never
 * invoke it. A static `import { S3Client } from "bun"` would fail to resolve on Node.
 */
export const defaultS3ClientFactory: S3ClientFactory = (opts) => {
	const client = new Bun.S3Client({
		bucket: opts.bucket,
		endpoint: opts.endpoint,
		region: opts.region,
		virtualHostedStyle: opts.virtualHostedStyle,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		sessionToken: opts.sessionToken,
	});
	return {
		list: (input) => client.list(input),
		stat: (key) => client.stat(key),
		async readBytes(key, maxBytes) {
			const file = client.file(key);
			// slice(0, maxBytes+1): the extra byte tells us whether the object exceeds the cap.
			const probe = file.slice(0, maxBytes + 1);
			const buf = await probe.arrayBuffer();
			const all = new Uint8Array(buf);
			const truncated = all.byteLength > maxBytes;
			const bytes = truncated ? all.subarray(0, maxBytes) : all;
			return { bytes, truncated, contentType: file.type };
		},
	};
};
```

- [ ] **Step 4: Run test to verify it passes** — `bun vitest run test/runtime/storage/s3-client.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/s3-client.ts test/runtime/storage/s3-client.test.ts
git commit -m "feat(storage): injectable S3 client seam (Bun-only lazy factory)"
```

---

### Task 5: StorageService (read-only ops + caps + connection CRUD)

**Files:**
- Create: `src/storage/s3-service.ts`
- Create: `src/storage/index.ts` (barrel — export service, factories, store, mapping types)
- Test: `test/runtime/storage/s3-service.test.ts`

**Constants:** `STORAGE_TEXT_MAX_BYTES = 1_048_576`, `STORAGE_PREVIEW_MAX_BYTES = 8_388_608`, `STORAGE_DOWNLOAD_MAX_BYTES = 104_857_600`.

**Interfaces:**
- Consumes: Tasks 1–4 + `import { Buffer } from "node:buffer"`.
- Produces `StorageService` with deps:
  ```ts
  interface StorageServiceDeps {
    createClient: S3ClientFactory;
    loadConnection: (connId: string) => Promise<StorageConnectionRecord | null>;
    loadCredential: (connId: string) => Promise<StorageCredential | undefined>;
  }
  ```
  Methods (all read-only; NO write/delete/presign exists):
  - `testConnection(connId): Promise<{ ok: boolean; latencyMs: number; error: string | null }>`
  - `listObjects(connId, { prefix?, continuationToken?, maxKeys? }): Promise<{ prefix: string; entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string }>`
  - `statObject(connId, key): Promise<{ key: string; size: number; lastModified: string; etag: string; contentType: string }>`
  - `readObject(connId, key): Promise<{ key: string; encoding: "utf8" | "base64"; content: string | null; size: number; lastModified: string; etag: string; contentType: string; binary: boolean; tooLarge: boolean }>`
  - `downloadObject(connId, key): Promise<{ fileName: string; contentType: string; data: string | null; tooLarge: boolean }>` (base64, capped at 100 MB)
- Also `now()` clock note: `testConnection` uses `performance.now()` (allowed; not `Date.now()`).

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/s3-service.test.ts
import { describe, expect, it } from "vitest";
import type { S3ClientLike } from "../../../src/storage/s3-client";
import { StorageService } from "../../../src/storage/s3-service";
import type { StorageConnectionRecord } from "../../../src/storage/storage-connection-record";

const record: StorageConnectionRecord = {
	connId: "r2",
	label: "R2",
	endpoint: null,
	region: null,
	bucket: "assets",
	virtualHostedStyle: false,
	createdAt: "2026-07-02T00:00:00.000Z",
};

function serviceWith(client: Partial<S3ClientLike>): StorageService {
	return new StorageService({
		createClient: () => client as S3ClientLike,
		loadConnection: async () => record,
		loadCredential: async () => ({ accessKeyId: "AK", secretAccessKey: "SK" }),
	});
}

describe("StorageService", () => {
	it("listObjects always uses delimiter '/' and maps entries", async () => {
		let seen: unknown;
		const svc = serviceWith({
			async list(input) {
				seen = input;
				return { commonPrefixes: [{ prefix: "a/" }], contents: [{ key: "x.txt", size: 3 }], isTruncated: false };
			},
		});
		const out = await svc.listObjects("r2", { prefix: "" });
		expect(seen).toMatchObject({ delimiter: "/", prefix: "" });
		expect(out.entries.map((e) => e.kind)).toEqual(["prefix", "object"]);
	});

	it("readObject returns utf8 text under the cap", async () => {
		const svc = serviceWith({
			async readBytes() {
				return { bytes: new TextEncoder().encode("hello"), truncated: false, contentType: "text/plain" };
			},
			async stat() {
				return { size: 5, lastModified: new Date(0), etag: "e", type: "text/plain" };
			},
		});
		const out = await svc.readObject("r2", "greeting.txt");
		expect(out).toMatchObject({ encoding: "utf8", content: "hello", binary: false, tooLarge: false });
	});

	it("readObject base64-encodes binary content", async () => {
		const svc = serviceWith({
			async readBytes() {
				return { bytes: new Uint8Array([0, 1, 2]), truncated: false, contentType: "application/octet-stream" };
			},
			async stat() {
				return { size: 3, lastModified: new Date(0), etag: "e", type: "application/octet-stream" };
			},
		});
		const out = await svc.readObject("r2", "blob.bin");
		expect(out.encoding).toBe("base64");
		expect(out.binary).toBe(true);
		expect(out.content).toBe(Buffer.from([0, 1, 2]).toString("base64"));
	});

	it("readObject flags tooLarge and returns no content when the object exceeds the cap", async () => {
		const svc = serviceWith({
			async readBytes(_key, maxBytes) {
				return { bytes: new Uint8Array(maxBytes), truncated: true, contentType: "text/plain" };
			},
			async stat() {
				return { size: 999_999_999, lastModified: new Date(0), etag: "e", type: "text/plain" };
			},
		});
		const out = await svc.readObject("r2", "big.txt");
		expect(out.tooLarge).toBe(true);
		expect(out.content).toBeNull();
	});

	it("testConnection reports ok on a successful probe", async () => {
		const svc = serviceWith({
			async list() {
				return { contents: [], isTruncated: false };
			},
		});
		const out = await svc.testConnection("r2");
		expect(out.ok).toBe(true);
		expect(out.error).toBeNull();
	});

	it("testConnection reports the error message on failure", async () => {
		const svc = serviceWith({
			async list() {
				throw new Error("AccessDenied");
			},
		});
		const out = await svc.testConnection("r2");
		expect(out.ok).toBe(false);
		expect(out.error).toContain("AccessDenied");
	});

	it("exposes no write/delete/presign methods (read-only is structural)", () => {
		const svc = serviceWith({});
		expect((svc as unknown as Record<string, unknown>).presign).toBeUndefined();
		expect((svc as unknown as Record<string, unknown>).deleteObject).toBeUndefined();
		expect((svc as unknown as Record<string, unknown>).writeObject).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun vitest run test/runtime/storage/s3-service.test.ts` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/storage/s3-service.ts
import { Buffer } from "node:buffer";

import { createLogger } from "../logging";
import type { S3ClientFactory, S3ClientLike } from "./s3-client";
import { classifyContent, mapListResponse, basename, type StorageEntry } from "./storage-object-mapping";
import { resolveS3ClientOptions } from "./storage-connection-store";
import type { StorageConnectionRecord, StorageCredential } from "./storage-connection-record";

const log = createLogger("storage:service");

export const STORAGE_TEXT_MAX_BYTES = 1_048_576;
export const STORAGE_PREVIEW_MAX_BYTES = 8_388_608;
export const STORAGE_DOWNLOAD_MAX_BYTES = 104_857_600;

export interface StorageServiceDeps {
	createClient: S3ClientFactory;
	loadConnection: (connId: string) => Promise<StorageConnectionRecord | null>;
	loadCredential: (connId: string) => Promise<StorageCredential | undefined>;
}

export interface ListObjectsInput {
	prefix?: string;
	continuationToken?: string;
	maxKeys?: number;
}

export interface StorageObjectContent {
	key: string;
	encoding: "utf8" | "base64";
	content: string | null;
	size: number;
	lastModified: string;
	etag: string;
	contentType: string;
	binary: boolean;
	tooLarge: boolean;
}

/**
 * Read-only object-storage service. Mirrors DatabaseService's injected-deps shape. It deliberately
 * exposes NO write/delete/presign method — read-only is structural, not a runtime policy check.
 */
export class StorageService {
	constructor(private readonly deps: StorageServiceDeps) {}

	private async client(connId: string): Promise<S3ClientLike> {
		const record = await this.deps.loadConnection(connId);
		if (!record) {
			throw new Error(`Unknown storage connection "${connId}".`);
		}
		const credential = await this.deps.loadCredential(connId);
		return this.deps.createClient(resolveS3ClientOptions(record, credential));
	}

	async testConnection(connId: string): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
		const started = performance.now();
		try {
			const client = await this.client(connId);
			await client.list({ maxKeys: 1 });
			return { ok: true, latencyMs: Math.round(performance.now() - started), error: null };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, latencyMs: Math.round(performance.now() - started), error: message };
		}
	}

	async listObjects(
		connId: string,
		input: ListObjectsInput,
	): Promise<{ prefix: string; entries: StorageEntry[]; isTruncated: boolean; nextContinuationToken?: string }> {
		const prefix = input.prefix ?? "";
		const client = await this.client(connId);
		const res = await client.list({
			prefix,
			delimiter: "/",
			maxKeys: input.maxKeys ?? 1000,
			continuationToken: input.continuationToken,
		});
		const mapped = mapListResponse(prefix, res);
		return { prefix, ...mapped };
	}

	async statObject(
		connId: string,
		key: string,
	): Promise<{ key: string; size: number; lastModified: string; etag: string; contentType: string }> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		return {
			key,
			size: stat.size,
			lastModified: stat.lastModified.toISOString(),
			etag: stat.etag,
			contentType: stat.type,
		};
	}

	async readObject(connId: string, key: string): Promise<StorageObjectContent> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		const base = {
			key,
			size: stat.size,
			lastModified: stat.lastModified.toISOString(),
			etag: stat.etag,
			contentType: stat.type,
		};
		// Read up to the binary-preview cap so we can classify; text is separately capped below.
		const { bytes, contentType } = await client.readBytes(key, STORAGE_PREVIEW_MAX_BYTES);
		const { binary } = classifyContent(bytes, contentType || stat.type, key);
		const cap = binary ? STORAGE_PREVIEW_MAX_BYTES : STORAGE_TEXT_MAX_BYTES;
		if (stat.size > cap) {
			return { ...base, encoding: binary ? "base64" : "utf8", content: null, binary, tooLarge: true };
		}
		if (binary) {
			return { ...base, encoding: "base64", content: Buffer.from(bytes).toString("base64"), binary, tooLarge: false };
		}
		return { ...base, encoding: "utf8", content: new TextDecoder().decode(bytes), binary, tooLarge: false };
	}

	async downloadObject(
		connId: string,
		key: string,
	): Promise<{ fileName: string; contentType: string; data: string | null; tooLarge: boolean }> {
		const client = await this.client(connId);
		const stat = await client.stat(key);
		if (stat.size > STORAGE_DOWNLOAD_MAX_BYTES) {
			return { fileName: basename(key), contentType: stat.type, data: null, tooLarge: true };
		}
		const { bytes, contentType } = await client.readBytes(key, STORAGE_DOWNLOAD_MAX_BYTES);
		log.debug("downloaded storage object", { connId, key, size: bytes.byteLength });
		return { fileName: basename(key), contentType: contentType || stat.type, data: Buffer.from(bytes).toString("base64"), tooLarge: false };
	}
}
```

```ts
// src/storage/index.ts
export { StorageService, STORAGE_TEXT_MAX_BYTES, STORAGE_PREVIEW_MAX_BYTES, STORAGE_DOWNLOAD_MAX_BYTES } from "./s3-service";
export type { StorageServiceDeps, ListObjectsInput, StorageObjectContent } from "./s3-service";
export { defaultS3ClientFactory } from "./s3-client";
export type { S3ClientFactory, S3ClientLike } from "./s3-client";
export {
	normalizeConnId,
	readStorageConnections,
	writeStorageConnections,
	readStorageCredentials,
	writeStorageCredentials,
	resolveS3ClientOptions,
} from "./storage-connection-store";
export type { ResolvedS3ClientOptions } from "./storage-connection-store";
export type { StorageConnectionRecord, StorageCredential } from "./storage-connection-record";
export { mapListResponse, basename, isTextKey, classifyContent } from "./storage-object-mapping";
export type { StorageEntry } from "./storage-object-mapping";
```

- [ ] **Step 4: Run test to verify it passes** — `bun vitest run test/runtime/storage/s3-service.test.ts` → PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/s3-service.ts src/storage/index.ts test/runtime/storage/s3-service.test.ts
git commit -m "feat(storage): read-only StorageService with caps + binary classification"
```

---

### Task 6: API-contract schemas (Runtime storage types)

**Files:**
- Modify: `src/core/api-contract.ts` (add a Storage section near the DB section; also add the access-gate field in Task 9)
- Test: `test/runtime/storage/storage-contract.test.ts`

**Interfaces (Produces):** zod schemas + inferred types:
- `runtimeStorageConnectionSchema` → `{ connId, label, endpoint: string | null, region: string | null, bucket, virtualHostedStyle, hasCredential, createdAt }`
- `runtimeStorageConnectionsListResponseSchema` → `{ connections: [...] }`
- `runtimeStorageUpsertConnectionRequestSchema` → `{ connId?: string; label; endpoint: string | null; region: string | null; bucket; virtualHostedStyle; accessKeyId?: string | null; secretAccessKey?: string | null; sessionToken?: string | null }`
- `runtimeStorageUpsertConnectionResponseSchema` → `{ connection }`
- `runtimeStorageDeleteConnectionRequestSchema` / `...ResponseSchema` (`{ connId }` / `{ deleted }`)
- `runtimeStorageTestConnectionRequestSchema` / `...ResponseSchema` (`{ connId }` / `{ ok, latencyMs, error: string | null }`)
- `runtimeStorageEntrySchema` (`kind: "prefix" | "object"`, key, name, size?, lastModified?, etag?)
- `runtimeStorageListRequestSchema` (`{ connId, prefix?, continuationToken?, maxKeys? }`) / `runtimeStorageListResponseSchema` (`{ prefix, entries, isTruncated, nextContinuationToken? }`)
- `runtimeStorageReadRequestSchema` (`{ connId, key }`) / `runtimeStorageObjectContentSchema`
- `runtimeStorageStatRequestSchema` / `runtimeStorageStatResponseSchema`
- `runtimeStorageDownloadRequestSchema` / `runtimeStorageDownloadResponseSchema`

Convention note: secret fields in the upsert request accept `string | null | undefined` (string sets, `null`/`""` clears, `undefined` keeps) — mirror `runtimeDbUpsertConnectionRequestSchema`'s `password`.

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/storage-contract.test.ts
import { describe, expect, it } from "vitest";
import {
	runtimeStorageEntrySchema,
	runtimeStorageListResponseSchema,
	runtimeStorageUpsertConnectionRequestSchema,
} from "../../../src/core/api-contract";

describe("storage contract", () => {
	it("parses a prefix entry", () => {
		expect(runtimeStorageEntrySchema.parse({ key: "a/", name: "a", kind: "prefix" }).kind).toBe("prefix");
	});
	it("parses a list response with a continuation token", () => {
		const out = runtimeStorageListResponseSchema.parse({
			prefix: "",
			entries: [{ key: "x.txt", name: "x.txt", kind: "object", size: 3 }],
			isTruncated: true,
			nextContinuationToken: "T",
		});
		expect(out.entries).toHaveLength(1);
	});
	it("accepts null secrets in the upsert request (clear semantics)", () => {
		const out = runtimeStorageUpsertConnectionRequestSchema.parse({
			label: "R2",
			endpoint: null,
			region: null,
			bucket: "assets",
			virtualHostedStyle: false,
			accessKeyId: null,
			secretAccessKey: null,
		});
		expect(out.accessKeyId).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (schemas not exported).

- [ ] **Step 3: Write minimal implementation** — add near the DB contract block in `src/core/api-contract.ts`:

```ts
// --- S3 object storage (read-only browsing) ---
export const runtimeStorageConnectionSchema = z.object({
	connId: z.string(),
	label: z.string(),
	endpoint: z.string().nullable(),
	region: z.string().nullable(),
	bucket: z.string(),
	virtualHostedStyle: z.boolean(),
	hasCredential: z.boolean(),
	createdAt: z.string(),
});
export type RuntimeStorageConnection = z.infer<typeof runtimeStorageConnectionSchema>;

export const runtimeStorageConnectionsListResponseSchema = z.object({
	connections: z.array(runtimeStorageConnectionSchema),
});
export type RuntimeStorageConnectionsListResponse = z.infer<typeof runtimeStorageConnectionsListResponseSchema>;

export const runtimeStorageUpsertConnectionRequestSchema = z.object({
	connId: z.string().optional(),
	label: z.string().min(1),
	endpoint: z.string().nullable(),
	region: z.string().nullable(),
	bucket: z.string().min(1),
	virtualHostedStyle: z.boolean(),
	accessKeyId: z.string().nullable().optional(),
	secretAccessKey: z.string().nullable().optional(),
	sessionToken: z.string().nullable().optional(),
});
export type RuntimeStorageUpsertConnectionRequest = z.infer<typeof runtimeStorageUpsertConnectionRequestSchema>;

export const runtimeStorageUpsertConnectionResponseSchema = z.object({ connection: runtimeStorageConnectionSchema });
export type RuntimeStorageUpsertConnectionResponse = z.infer<typeof runtimeStorageUpsertConnectionResponseSchema>;

export const runtimeStorageDeleteConnectionRequestSchema = z.object({ connId: z.string() });
export type RuntimeStorageDeleteConnectionRequest = z.infer<typeof runtimeStorageDeleteConnectionRequestSchema>;
export const runtimeStorageDeleteConnectionResponseSchema = z.object({ deleted: z.boolean() });
export type RuntimeStorageDeleteConnectionResponse = z.infer<typeof runtimeStorageDeleteConnectionResponseSchema>;

export const runtimeStorageTestConnectionRequestSchema = z.object({ connId: z.string() });
export type RuntimeStorageTestConnectionRequest = z.infer<typeof runtimeStorageTestConnectionRequestSchema>;
export const runtimeStorageTestConnectionResponseSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number(),
	error: z.string().nullable(),
});
export type RuntimeStorageTestConnectionResponse = z.infer<typeof runtimeStorageTestConnectionResponseSchema>;

export const runtimeStorageEntrySchema = z.object({
	key: z.string(),
	name: z.string(),
	kind: z.enum(["prefix", "object"]),
	size: z.number().optional(),
	lastModified: z.string().optional(),
	etag: z.string().optional(),
});
export type RuntimeStorageEntry = z.infer<typeof runtimeStorageEntrySchema>;

export const runtimeStorageListRequestSchema = z.object({
	connId: z.string(),
	prefix: z.string().optional(),
	continuationToken: z.string().optional(),
	maxKeys: z.number().int().positive().max(1000).optional(),
});
export type RuntimeStorageListRequest = z.infer<typeof runtimeStorageListRequestSchema>;
export const runtimeStorageListResponseSchema = z.object({
	prefix: z.string(),
	entries: z.array(runtimeStorageEntrySchema),
	isTruncated: z.boolean(),
	nextContinuationToken: z.string().optional(),
});
export type RuntimeStorageListResponse = z.infer<typeof runtimeStorageListResponseSchema>;

export const runtimeStorageReadRequestSchema = z.object({ connId: z.string(), key: z.string() });
export type RuntimeStorageReadRequest = z.infer<typeof runtimeStorageReadRequestSchema>;
export const runtimeStorageObjectContentSchema = z.object({
	key: z.string(),
	encoding: z.enum(["utf8", "base64"]),
	content: z.string().nullable(),
	size: z.number(),
	lastModified: z.string(),
	etag: z.string(),
	contentType: z.string(),
	binary: z.boolean(),
	tooLarge: z.boolean(),
});
export type RuntimeStorageObjectContent = z.infer<typeof runtimeStorageObjectContentSchema>;

export const runtimeStorageStatRequestSchema = z.object({ connId: z.string(), key: z.string() });
export type RuntimeStorageStatRequest = z.infer<typeof runtimeStorageStatRequestSchema>;
export const runtimeStorageStatResponseSchema = z.object({
	key: z.string(),
	size: z.number(),
	lastModified: z.string(),
	etag: z.string(),
	contentType: z.string(),
});
export type RuntimeStorageStatResponse = z.infer<typeof runtimeStorageStatResponseSchema>;

export const runtimeStorageDownloadRequestSchema = z.object({ connId: z.string(), key: z.string() });
export type RuntimeStorageDownloadRequest = z.infer<typeof runtimeStorageDownloadRequestSchema>;
export const runtimeStorageDownloadResponseSchema = z.object({
	fileName: z.string(),
	contentType: z.string(),
	data: z.string().nullable(),
	tooLarge: z.boolean(),
});
export type RuntimeStorageDownloadResponse = z.infer<typeof runtimeStorageDownloadResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes** — `bun vitest run test/runtime/storage/storage-contract.test.ts` → PASS.

- [ ] **Step 5: Typecheck** — `npm run typecheck` → no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/api-contract.ts test/runtime/storage/storage-contract.test.ts
git commit -m "feat(storage): api-contract schemas for storage connections + objects"
```

---

### Task 7: workspace-state path helpers + load/mutate pairs

**Files:**
- Modify: `src/state/workspace-state.ts` (add next to the DB helpers, ~lines 416–480)
- Test: `test/runtime/storage/workspace-storage-state.test.ts`

**Interfaces (Produces):**
- `getWorkspaceStorageConnectionsShardDir(repoPath, workspaceId): string`
- `getStorageCredentialsPath(): string` (`KANBAN_STORAGE_CREDENTIALS_PATH` override → else `<machine-home>/settings/storage-credentials.json`)
- `loadWorkspaceStorageConnections(workspaceId): Promise<StorageConnectionRecord[]>`
- `mutateWorkspaceStorageConnections(workspaceId, mutate): Promise<StorageConnectionRecord[]>`
- `loadStorageCredential(connId): Promise<StorageCredential | undefined>`
- `mutateStorageCredential(connId, mutate): Promise<void>`

- [ ] **Step 1: Write the failing test** (drive path helpers via the env override so no real repo is needed)

```ts
// test/runtime/storage/workspace-storage-state.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStorageCredentialsPath, loadStorageCredential, mutateStorageCredential } from "../../../src/state/workspace-state";

let dir: string;
let prev: string | undefined;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "kanban-storage-creds-"));
	prev = process.env.KANBAN_STORAGE_CREDENTIALS_PATH;
	process.env.KANBAN_STORAGE_CREDENTIALS_PATH = join(dir, "storage-credentials.json");
});
afterEach(async () => {
	if (prev === undefined) delete process.env.KANBAN_STORAGE_CREDENTIALS_PATH;
	else process.env.KANBAN_STORAGE_CREDENTIALS_PATH = prev;
	await rm(dir, { recursive: true, force: true });
});

describe("storage credential machine-home store", () => {
	it("honors the path override", () => {
		expect(getStorageCredentialsPath()).toBe(join(dir, "storage-credentials.json"));
	});
	it("sets then clears a credential", async () => {
		await mutateStorageCredential("r2", () => ({ accessKeyId: "AK", secretAccessKey: "SK" }));
		expect((await loadStorageCredential("R2"))?.accessKeyId).toBe("AK");
		await mutateStorageCredential("r2", () => undefined);
		expect(await loadStorageCredential("r2")).toBeUndefined();
	});
	it("writes the credentials file with 0600 mode", async () => {
		await mutateStorageCredential("r2", () => ({ accessKeyId: "AK" }));
		const { mode } = await (await import("node:fs/promises")).stat(getStorageCredentialsPath());
		expect(mode & 0o777).toBe(0o600);
	});
});
```

> Note: the last test's dynamic import is inside a TEST file (allowed for test ergonomics). Keep production code free of dynamic imports. If the repo's lint forbids it in tests too, hoist `import { stat } from "node:fs/promises"` to the top.

- [ ] **Step 2: Run test to verify it fails** — FAIL (functions not exported).

- [ ] **Step 3: Write minimal implementation** — mirror the DB helpers (`workspace-state.ts:416–480`). Add:

```ts
// near the other shard-dir constants
const STORAGE_CONNECTIONS_SHARD_DIRNAME = "storage-connections";

export function getWorkspaceStorageConnectionsShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), STORAGE_CONNECTIONS_SHARD_DIRNAME);
}

export function getStorageCredentialsPath(): string {
	const override = process.env.KANBAN_STORAGE_CREDENTIALS_PATH?.trim();
	if (override) {
		return override;
	}
	return join(getMachineKanbanHomePath(), "settings", "storage-credentials.json");
}

export async function loadWorkspaceStorageConnections(workspaceId: string): Promise<StorageConnectionRecord[]> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		return [];
	}
	return await readStorageConnections(getWorkspaceStorageConnectionsShardDir(repoPath, workspaceId));
}

export async function mutateWorkspaceStorageConnections(
	workspaceId: string,
	mutate: (records: StorageConnectionRecord[]) => StorageConnectionRecord[] | Promise<StorageConnectionRecord[]>,
): Promise<StorageConnectionRecord[]> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	const shardDir = getWorkspaceStorageConnectionsShardDir(repoPath, workspaceId);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const current = await readStorageConnections(shardDir);
		const next = await mutate(current);
		await writeStorageConnections(shardDir, next);
		return next;
	});
}

export async function loadStorageCredential(connId: string): Promise<StorageCredential | undefined> {
	const id = normalizeStorageConnId(connId);
	const data = await readStorageCredentials(getStorageCredentialsPath());
	return data.credentials[id];
}

export async function mutateStorageCredential(
	connId: string,
	mutate: (current: StorageCredential | undefined) => StorageCredential | undefined,
): Promise<void> {
	const path = getStorageCredentialsPath();
	const id = normalizeStorageConnId(connId);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const data = await readStorageCredentials(path);
		const next = mutate(data.credentials[id]);
		if (next === undefined) {
			delete data.credentials[id];
		} else {
			data.credentials[id] = next;
		}
		await writeStorageCredentials(path, data);
	});
}
```

Add imports at the top of `workspace-state.ts` (top-level, no aliasing collisions — the DB store's `normalizeConnId` is already imported, so import the storage one under an alias):

```ts
import {
	normalizeConnId as normalizeStorageConnId,
	readStorageConnections,
	writeStorageConnections,
	readStorageCredentials,
	writeStorageCredentials,
} from "../storage/storage-connection-store";
import type { StorageConnectionRecord, StorageCredential } from "../storage/storage-connection-record";
```

- [ ] **Step 4: Run test to verify it passes** — `bun vitest run test/runtime/storage/workspace-storage-state.test.ts` → PASS.

- [ ] **Step 5: Typecheck** — `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add src/state/workspace-state.ts test/runtime/storage/workspace-storage-state.test.ts
git commit -m "feat(storage): workspace-state shard-dir + machine-home credential helpers"
```

---

### Task 8: Per-workspace storage stack + workspace-storage tRPC api

**Files:**
- Create: `src/workspace/workspace-storage-service.ts`
- Create: `src/trpc/workspace-storage-api.ts`
- Test: `test/runtime/storage/workspace-storage-api.test.ts`

**Interfaces:**
- Consumes: `StorageService`, `defaultS3ClientFactory` (Task 5); the load/mutate helpers (Task 7); `RuntimeTrpcWorkspaceScope` (from `app-router.ts`/scope module); the contract types (Task 6).
- Produces:
  - `getWorkspaceStorageService(workspaceId: string): StorageService` (memoized per workspace; injects `defaultS3ClientFactory` + workspace-scoped loaders)
  - interface `WorkspaceStorageApi` + `createWorkspaceStorageApi(): WorkspaceStorageApi` with methods `listConnections/upsertConnection/deleteConnection/testConnection/listObjects/readObject/statObject/downloadObject`, each `(scope, input?) => Promise<...>`.

- [ ] **Step 1: Write `workspace-storage-service.ts`** (mirror `workspace-db-service.ts`)

```ts
// src/workspace/workspace-storage-service.ts
import { StorageService, defaultS3ClientFactory, normalizeConnId } from "../storage";
import type { StorageConnectionRecord } from "../storage";
import {
	loadStorageCredential,
	loadWorkspaceStorageConnections,
} from "../state/workspace-state";

const servicesByWorkspaceId = new Map<string, StorageService>();

/** Resolve (and memoize) the read-only storage service for a workspace. */
export function getWorkspaceStorageService(workspaceId: string): StorageService {
	const existing = servicesByWorkspaceId.get(workspaceId);
	if (existing) {
		return existing;
	}
	const loadConnection = async (connId: string): Promise<StorageConnectionRecord | null> => {
		const target = normalizeConnId(connId);
		const records = await loadWorkspaceStorageConnections(workspaceId);
		return records.find((r) => normalizeConnId(r.connId) === target) ?? null;
	};
	const created = new StorageService({
		createClient: defaultS3ClientFactory,
		loadConnection,
		loadCredential: (connId) => loadStorageCredential(connId),
	});
	servicesByWorkspaceId.set(workspaceId, created);
	return created;
}
```

- [ ] **Step 2: Write the failing test** (drive the api with a fake scope; monkeypatch not needed — test the mapping/upsert path against a temp repo is heavy, so test the *pure* toRuntimeConnection + the read procedures against the memoized service via env-scoped fakes). Minimal, focused test:

```ts
// test/runtime/storage/workspace-storage-api.test.ts
import { describe, expect, it } from "vitest";
import { toRuntimeStorageConnection } from "../../../src/trpc/workspace-storage-api";

describe("toRuntimeStorageConnection", () => {
	it("maps a record + credential flag to the wire connection", () => {
		const conn = toRuntimeStorageConnection(
			{
				connId: "r2",
				label: "R2",
				endpoint: "https://x.r2.cloudflarestorage.com",
				region: null,
				bucket: "assets",
				virtualHostedStyle: false,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
			true,
		);
		expect(conn).toMatchObject({ connId: "r2", bucket: "assets", hasCredential: true });
	});
});
```

- [ ] **Step 3: Run test to verify it fails** — FAIL (module not found).

- [ ] **Step 4: Write `workspace-storage-api.ts`** (mirror `workspace-db-api.ts`; caller is implicitly human — no policy since read-only)

```ts
// src/trpc/workspace-storage-api.ts
import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { createLogger } from "../logging";
import { normalizeConnId } from "../storage";
import type { StorageConnectionRecord } from "../storage";
import {
	loadStorageCredential,
	loadWorkspaceStorageConnections,
	mutateStorageCredential,
	mutateWorkspaceStorageConnections,
} from "../state/workspace-state";
import { safeRandomUUID } from "../core/safe-uuid"; // if present; else randomUUID from node:crypto
import type { RuntimeTrpcWorkspaceScope } from "./app-router";
import type {
	RuntimeStorageConnection,
	RuntimeStorageConnectionsListResponse,
	RuntimeStorageDeleteConnectionRequest,
	RuntimeStorageDeleteConnectionResponse,
	RuntimeStorageDownloadRequest,
	RuntimeStorageDownloadResponse,
	RuntimeStorageListRequest,
	RuntimeStorageListResponse,
	RuntimeStorageObjectContent,
	RuntimeStorageReadRequest,
	RuntimeStorageStatRequest,
	RuntimeStorageStatResponse,
	RuntimeStorageTestConnectionRequest,
	RuntimeStorageTestConnectionResponse,
	RuntimeStorageUpsertConnectionRequest,
	RuntimeStorageUpsertConnectionResponse,
} from "../core/api-contract";
import { getWorkspaceStorageService } from "../workspace/workspace-storage-service";

const log = createLogger("storage:api");

export function toRuntimeStorageConnection(
	record: StorageConnectionRecord,
	hasCredential: boolean,
): RuntimeStorageConnection {
	return {
		connId: record.connId,
		label: record.label,
		endpoint: record.endpoint,
		region: record.region,
		bucket: record.bucket,
		virtualHostedStyle: record.virtualHostedStyle,
		hasCredential,
		createdAt: record.createdAt,
	};
}

async function hasStoredCredential(connId: string): Promise<boolean> {
	const cred = await loadStorageCredential(connId);
	return Boolean(cred?.accessKeyId && cred?.secretAccessKey);
}

export interface WorkspaceStorageApi {
	listConnections: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeStorageConnectionsListResponse>;
	upsertConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageUpsertConnectionRequest,
	) => Promise<RuntimeStorageUpsertConnectionResponse>;
	deleteConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageDeleteConnectionRequest,
	) => Promise<RuntimeStorageDeleteConnectionResponse>;
	testConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageTestConnectionRequest,
	) => Promise<RuntimeStorageTestConnectionResponse>;
	listObjects: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageListRequest) => Promise<RuntimeStorageListResponse>;
	readObject: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageReadRequest) => Promise<RuntimeStorageObjectContent>;
	statObject: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageStatRequest) => Promise<RuntimeStorageStatResponse>;
	downloadObject: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageDownloadRequest,
	) => Promise<RuntimeStorageDownloadResponse>;
}

export function createWorkspaceStorageApi(): WorkspaceStorageApi {
	return {
		async listConnections(scope) {
			const records = await loadWorkspaceStorageConnections(scope.workspaceId);
			const connections = await Promise.all(
				records.map(async (record) => toRuntimeStorageConnection(record, await hasStoredCredential(record.connId))),
			);
			return { connections };
		},

		async upsertConnection(scope, input) {
			const connId = normalizeConnId(input.connId ?? randomUUID());
			const records = await mutateWorkspaceStorageConnections(scope.workspaceId, (current) => {
				const existing = current.find((r) => normalizeConnId(r.connId) === connId);
				const next: StorageConnectionRecord = {
					connId,
					label: input.label,
					endpoint: input.endpoint,
					region: input.region,
					bucket: input.bucket,
					virtualHostedStyle: input.virtualHostedStyle,
					createdAt: existing?.createdAt ?? new Date().toISOString(),
				};
				return [...current.filter((r) => normalizeConnId(r.connId) !== connId), next];
			});

			// Apply the secret only when a full pair is provided; null/"" clears; undefined keeps.
			const setKey = input.accessKeyId;
			const setSecret = input.secretAccessKey;
			if (setKey !== undefined || setSecret !== undefined || input.sessionToken !== undefined) {
				await mutateStorageCredential(connId, (cur) => {
					const clearing =
						(setKey === null || setKey === "") && (setSecret === null || setSecret === "");
					if (clearing) {
						return undefined;
					}
					return {
						accessKeyId: setKey ?? cur?.accessKeyId,
						secretAccessKey: setSecret ?? cur?.secretAccessKey,
						sessionToken:
							input.sessionToken === null || input.sessionToken === ""
								? undefined
								: (input.sessionToken ?? cur?.sessionToken),
					};
				});
			}

			const saved = records.find((r) => normalizeConnId(r.connId) === connId);
			if (!saved) {
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to persist storage connection." });
			}
			log.info(input.connId ? "updated storage connection" : "created storage connection", { connId, bucket: input.bucket });
			return { connection: toRuntimeStorageConnection(saved, await hasStoredCredential(connId)) };
		},

		async deleteConnection(scope, input) {
			const connId = normalizeConnId(input.connId);
			let deleted = false;
			await mutateWorkspaceStorageConnections(scope.workspaceId, (current) => {
				const next = current.filter((r) => normalizeConnId(r.connId) !== connId);
				deleted = next.length !== current.length;
				return next;
			});
			if (deleted) {
				await mutateStorageCredential(connId, () => undefined);
				log.info("deleted storage connection", { connId });
			}
			return { deleted };
		},

		async testConnection(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).testConnection(input.connId);
		},
		async listObjects(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).listObjects(input.connId, {
				prefix: input.prefix,
				continuationToken: input.continuationToken,
				maxKeys: input.maxKeys,
			});
		},
		async readObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).readObject(input.connId, input.key);
		},
		async statObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).statObject(input.connId, input.key);
		},
		async downloadObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).downloadObject(input.connId, input.key);
		},
	};
}
```

> If `safeRandomUUID` (`src/core/safe-uuid`) exists, prefer it over `randomUUID` (per the safe-uuid memory). Remove the unused import accordingly.

- [ ] **Step 5: Run test to verify it passes** — `bun vitest run test/runtime/storage/workspace-storage-api.test.ts` → PASS.

- [ ] **Step 6: Typecheck** — `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/workspace/workspace-storage-service.ts src/trpc/workspace-storage-api.ts test/runtime/storage/workspace-storage-api.test.ts
git commit -m "feat(storage): per-workspace storage service + tRPC api layer"
```

---

### Task 9: Access gate field (`agentStorageAccessEnabled`)

**Files:**
- Modify: `src/core/api-contract.ts` (`runtimeVaultSettingsSchema` line ~1012, `...UpdateRequestSchema` line ~1037)
- Modify: `src/vault/vault-settings-store.ts` (`update` patch branch, lines ~99–108)
- Test: `test/runtime/storage/storage-access-gate.test.ts`

**Interfaces:** adds `agentStorageAccessEnabled: boolean` to `RuntimeVaultSettings` (default false) + optional to the update request.

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/storage/storage-access-gate.test.ts
import { describe, expect, it } from "vitest";
import { runtimeVaultSettingsSchema, runtimeVaultSettingsUpdateRequestSchema } from "../../../src/core/api-contract";

describe("agentStorageAccessEnabled", () => {
	it("defaults to false", () => {
		expect(runtimeVaultSettingsSchema.parse({}).agentStorageAccessEnabled).toBe(false);
	});
	it("is an optional boolean in the update request", () => {
		expect(runtimeVaultSettingsUpdateRequestSchema.parse({ agentStorageAccessEnabled: true }).agentStorageAccessEnabled).toBe(true);
		expect(runtimeVaultSettingsUpdateRequestSchema.parse({}).agentStorageAccessEnabled).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (field missing).

- [ ] **Step 3: Write implementation**

In `runtimeVaultSettingsSchema` add: `agentStorageAccessEnabled: z.boolean().default(false),`
In `runtimeVaultSettingsUpdateRequestSchema` add: `agentStorageAccessEnabled: z.boolean().optional(),`
In `vault-settings-store.ts` `update()` add a spread branch mirroring the DB one:

```ts
...(patch.agentStorageAccessEnabled !== undefined
	? { agentStorageAccessEnabled: patch.agentStorageAccessEnabled }
	: {}),
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Typecheck** — `npm run typecheck` (the `RuntimeVaultSettings` widening may surface a couple of exhaustiveness spots — fix by adding the field where objects are constructed literally).

- [ ] **Step 6: Commit**

```bash
git add src/core/api-contract.ts src/vault/vault-settings-store.ts test/runtime/storage/storage-access-gate.test.ts
git commit -m "feat(storage): per-workspace agentStorageAccessEnabled gate field"
```

---

### Task 10: Wire the storage router into the app + context

**Files:**
- Modify: `src/trpc/app-router.ts` (import `WorkspaceStorageApi`; merge into `RuntimeTrpcContext.workspaceApi` type ~line 688; add a `storage: t.router({...})` sub-router next to `database` ~line 1447)
- Modify: wherever `createWorkspaceApi(...)` composes the workspace api (so the returned object also spreads `createWorkspaceStorageApi()`), OR add a dedicated `ctx.storageApi` — **choose to spread into `workspaceApi`** to match how `WorkspaceDbApi` is merged. Find the spot in `src/server/runtime-server.ts` (`workspaceApi: createWorkspaceApi({...})`) and the `createWorkspaceApi` definition.
- Test: `test/runtime/storage/storage-router.test.ts` (calls a couple of procedures through the router with a fake context)

**Interfaces:**
- Consumes: `createWorkspaceStorageApi` (Task 8), storage request/response schemas (Task 6).

- [ ] **Step 1: Determine how `WorkspaceDbApi` is merged**

Run: `grep -n "WorkspaceDbApi\|createWorkspaceDbApi\|createWorkspaceApi" src/trpc/app-router.ts src/server/runtime-server.ts src/trpc/*.ts`
Confirm whether `createWorkspaceApi` spreads `createWorkspaceDbApi()`. Mirror exactly for storage.

- [ ] **Step 2: Add the type merge** in `app-router.ts`:

```ts
import type { WorkspaceStorageApi } from "./workspace-storage-api";
// ... in RuntimeTrpcContext.workspaceApi type:
	} & WorkspaceDbApi & WorkspaceStorageApi;
```

- [ ] **Step 3: Add the sub-router** in `app-router.ts` next to `database:`:

```ts
	storage: t.router({
		listConnections: workspaceProcedure
			.output(runtimeStorageConnectionsListResponseSchema)
			.query(async ({ ctx }) => ctx.workspaceApi.listConnections(ctx.workspaceScope)),
		upsertConnection: workspaceProcedure
			.input(runtimeStorageUpsertConnectionRequestSchema)
			.output(runtimeStorageUpsertConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => ctx.workspaceApi.upsertConnection(ctx.workspaceScope, input)),
		deleteConnection: workspaceProcedure
			.input(runtimeStorageDeleteConnectionRequestSchema)
			.output(runtimeStorageDeleteConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => ctx.workspaceApi.deleteConnection(ctx.workspaceScope, input)),
		testConnection: workspaceProcedure
			.input(runtimeStorageTestConnectionRequestSchema)
			.output(runtimeStorageTestConnectionResponseSchema)
			.mutation(async ({ ctx, input }) => ctx.workspaceApi.testConnection(ctx.workspaceScope, input)),
		listObjects: workspaceProcedure
			.input(runtimeStorageListRequestSchema)
			.output(runtimeStorageListResponseSchema)
			.query(async ({ ctx, input }) => ctx.workspaceApi.listObjects(ctx.workspaceScope, input)),
		readObject: workspaceProcedure
			.input(runtimeStorageReadRequestSchema)
			.output(runtimeStorageObjectContentSchema)
			.query(async ({ ctx, input }) => ctx.workspaceApi.readObject(ctx.workspaceScope, input)),
		statObject: workspaceProcedure
			.input(runtimeStorageStatRequestSchema)
			.output(runtimeStorageStatResponseSchema)
			.query(async ({ ctx, input }) => ctx.workspaceApi.statObject(ctx.workspaceScope, input)),
		downloadObject: workspaceProcedure
			.input(runtimeStorageDownloadRequestSchema)
			.output(runtimeStorageDownloadResponseSchema)
			.query(async ({ ctx, input }) => ctx.workspaceApi.downloadObject(ctx.workspaceScope, input)),
	}),
```

Add the schema imports at the top of `app-router.ts` (they come from `../core/api-contract`).

- [ ] **Step 4: Spread the storage api** wherever `createWorkspaceApi` builds its return (mirror the db spread). Then `npm run typecheck` will confirm `ctx.workspaceApi.listObjects` etc. resolve.

- [ ] **Step 5: Typecheck (both libs)** — `npm run typecheck && npm --prefix web-ui run typecheck` (the `web:typecheck` pass exercises the router type via `@runtime-contract`; watch the base64 `data` string field — it's a `string`, DOM-safe, so no Uint8Array/Blob crosses the boundary here).

- [ ] **Step 6: Commit**

```bash
git add src/trpc/app-router.ts src/server/runtime-server.ts src/trpc/*.ts
git commit -m "feat(storage): mount storage tRPC router + merge into workspace api"
```

---

### Task 11: web-ui — storage hooks

**Files:**
- Create: `web-ui/src/components/storage/use-storage-connections.ts`
- Create: `web-ui/src/components/storage/use-storage-tree.ts`
- Create: `web-ui/src/components/storage/use-storage-object.ts`

**Interfaces:** mirror `web-ui/src/components/database/use-db-connections.ts`. All tRPC calls go through `getRuntimeTrpcClient(workspaceId).storage.<proc>.query/mutate(...)`.

- [ ] **Step 1: `use-storage-connections.ts`** (pattern-match `use-db-connections.ts` exactly, swapping `database` → `storage`)

```ts
import { useCallback, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query"; // confirm the real hook path from use-db-connections.ts
import type { RuntimeStorageUpsertConnectionRequest } from "@runtime-contract";

export function useStorageConnections(workspaceId: string | null) {
	const [isMutating, setIsMutating] = useState(false);
	const queryFn = useCallback(async () => {
		if (!workspaceId) throw new Error("Missing workspace.");
		return await getRuntimeTrpcClient(workspaceId).storage.listConnections.query();
	}, [workspaceId]);
	const query = useTrpcQuery({ enabled: workspaceId !== null, queryFn, retainDataOnError: true });
	const { refetch: rawRefetch } = query;

	const upsertConnection = useCallback(
		async (input: RuntimeStorageUpsertConnectionRequest) => {
			if (!workspaceId) throw new Error("Missing workspace.");
			setIsMutating(true);
			try {
				const r = await getRuntimeTrpcClient(workspaceId).storage.upsertConnection.mutate(input);
				await rawRefetch();
				return r.connection;
			} finally {
				setIsMutating(false);
			}
		},
		[workspaceId, rawRefetch],
	);
	const deleteConnection = useCallback(
		async (connId: string) => {
			if (!workspaceId) throw new Error("Missing workspace.");
			const r = await getRuntimeTrpcClient(workspaceId).storage.deleteConnection.mutate({ connId });
			await rawRefetch();
			return r.deleted;
		},
		[workspaceId, rawRefetch],
	);
	const testConnection = useCallback(
		async (connId: string) => {
			if (!workspaceId) throw new Error("Missing workspace.");
			return await getRuntimeTrpcClient(workspaceId).storage.testConnection.mutate({ connId });
		},
		[workspaceId],
	);

	return {
		connections: query.data?.connections ?? [],
		isLoading: query.isLoading,
		errorMessage: query.isError ? (query.error?.message ?? "Failed to load connections.") : null,
		isMutating,
		refetch: rawRefetch,
		upsertConnection,
		deleteConnection,
		testConnection,
	};
}
```

> Before writing, open `use-db-connections.ts` and copy the EXACT import paths for `useTrpcQuery` (or whatever query hook it uses) — do not guess. `@runtime-contract` is the alias for the backend contract types (confirm in `web-ui/tsconfig`).

- [ ] **Step 2: `use-storage-tree.ts`** — single-level list + continuation paging:

```ts
import { useCallback, useEffect, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeStorageEntry } from "@runtime-contract";

export function useStorageTree(workspaceId: string | null, connId: string | null) {
	const [prefix, setPrefix] = useState("");
	const [entries, setEntries] = useState<RuntimeStorageEntry[]>([]);
	const [isTruncated, setIsTruncated] = useState(false);
	const [token, setToken] = useState<string | undefined>(undefined);
	const [isLoading, setIsLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const load = useCallback(
		async (nextPrefix: string, continuationToken?: string) => {
			if (!workspaceId || !connId) return;
			setIsLoading(true);
			setErrorMessage(null);
			try {
				const res = await getRuntimeTrpcClient(workspaceId).storage.listObjects.query({
					connId,
					prefix: nextPrefix,
					continuationToken,
				});
				setPrefix(res.prefix);
				setEntries((prev) => (continuationToken ? [...prev, ...res.entries] : res.entries));
				setIsTruncated(res.isTruncated);
				setToken(res.nextContinuationToken);
			} catch (err) {
				setErrorMessage(err instanceof Error ? err.message : "Failed to list objects.");
			} finally {
				setIsLoading(false);
			}
		},
		[workspaceId, connId],
	);

	// Reset to bucket root whenever the connection changes.
	useEffect(() => {
		setEntries([]);
		if (connId) void load("");
	}, [connId, load]);

	const enter = useCallback((p: string) => void load(p), [load]);
	const loadMore = useCallback(() => {
		if (isTruncated && token) void load(prefix, token);
	}, [isTruncated, token, prefix, load]);

	return { prefix, entries, isTruncated, isLoading, errorMessage, enter, loadMore, reload: () => void load(prefix) };
}
```

- [ ] **Step 3: `use-storage-object.ts`** — fetch one object's content:

```ts
import { useCallback, useEffect, useState } from "react";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeStorageObjectContent } from "@runtime-contract";

export function useStorageObject(workspaceId: string | null, connId: string | null, key: string | null) {
	const [content, setContent] = useState<RuntimeStorageObjectContent | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!workspaceId || !connId || !key) {
			setContent(null);
			return;
		}
		setIsLoading(true);
		setErrorMessage(null);
		try {
			setContent(await getRuntimeTrpcClient(workspaceId).storage.readObject.query({ connId, key }));
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : "Failed to read object.");
		} finally {
			setIsLoading(false);
		}
	}, [workspaceId, connId, key]);

	useEffect(() => {
		void load();
	}, [load]);

	return { content, isLoading, errorMessage, reload: load };
}
```

- [ ] **Step 4: Typecheck web-ui** — `npm --prefix web-ui run typecheck`. Fix any import-path guesses against the real files.

- [ ] **Step 5: Commit**

```bash
git add web-ui/src/components/storage/use-storage-connections.ts web-ui/src/components/storage/use-storage-tree.ts web-ui/src/components/storage/use-storage-object.ts
git commit -m "feat(storage): web-ui storage hooks (connections, tree, object)"
```

---

### Task 12: web-ui — StorageView (sidebar + browser + connection dialog + viewer)

**Files:**
- Create: `web-ui/src/components/storage/storage-view.tsx`
- Create: `web-ui/src/components/storage/storage-sidebar.tsx`
- Create: `web-ui/src/components/storage/storage-connection-dialog.tsx`
- Create: `web-ui/src/components/storage/storage-object-browser.tsx`
- Create: `web-ui/src/components/storage/storage-object-viewer.tsx`

**Interfaces:** `StorageView` is `({ workspaceId }: { workspaceId: string | null }) => React.ReactElement`, mirroring `DatabaseView`'s prop.

**Design constraints for the implementer:**
- **Sidebar** (`storage-sidebar.tsx`): list `connections` from `useStorageConnections`; each row selects a connection; a `+` opens `StorageConnectionDialog`; row hover shows edit/delete. Pattern-match `database-sidebar.tsx` layout + `bg-surface-*` tokens.
- **Connection dialog** (`storage-connection-dialog.tsx`): fields `label`, `endpoint` (optional; placeholder "https://<acct>.r2.cloudflarestorage.com / http://localhost:9000"), `region` (optional), `bucket` (required), `virtualHostedStyle` (switch, default off, helper "off = path-style, needed for MinIO"), `accessKeyId`, `secretAccessKey` (password input; on edit show a "leave blank to keep" placeholder and send `undefined` when untouched), `sessionToken` (optional). A "Test" button calls `testConnection` and shows ok/latency/error. Uses `Dialog`/`DialogHeader`/`DialogBody`/`DialogFooter` + `Button`. Pattern-match `connection-dialog.tsx`.
- **Object browser** (`storage-object-browser.tsx`): breadcrumb built by splitting `prefix` on `/`; a single-level list of `entries` (folder icon for `kind==="prefix"`, `iconForFile(name)` for objects, plus size/lastModified columns); double-click a prefix → `enter(entry.key)`; breadcrumb segment click → `enter(prefixUpTo)`; a "Load more" button when `isTruncated`. Selecting an object sets the active key. Reuse the file-surface icon helper (import from `web-ui/src/components/file-surface/filesystem/...`; confirm the exact export name via grep).
- **Object viewer** (`storage-object-viewer.tsx`): consumes `useStorageObject`; when `tooLarge` show a "Too large to preview — download" affordance (calls `storage.downloadObject`, decodes base64, triggers a browser download — mirror `use-fs-download.ts`); when `binary` and an image content-type, render a data-URI `<img>`; when text, render the reused CodeMirror viewer (`CodeEditorLazy` from `web-ui/src/components/file-surface/filesystem/code-editor-lazy.tsx` — read-only mode) with a language guessed from the key extension. Show a small stat strip (size · lastModified · etag · contentType).
- **StorageView** (`storage-view.tsx`): two-pane layout — `StorageSidebar` (left) + (`StorageObjectBrowser` over `StorageObjectViewer`, right). Holds `selectedConnId` and `selectedKey` state. When no connection is selected, show an empty-state prompting to add one.

- [ ] **Step 1: Read the siblings to copy structure exactly**

Run:
```
sed -n '1,60p' web-ui/src/components/database/database-view.tsx
sed -n '1,80p' web-ui/src/components/database/connection-dialog.tsx
grep -rn "iconForFile\|CodeEditorLazy\|BinaryPreview" web-ui/src/components/file-surface/filesystem/
sed -n '1,80p' web-ui/src/components/file-surface/filesystem/use-fs-download.ts
```
Note the exact exports/props you'll reuse.

- [ ] **Step 2: Implement the five components** following the constraints above, reusing `@/components/ui/*` primitives (`Button`, `Dialog*`, `Tooltip`, `Spinner`, `Switch` via Radix) and design tokens. Keep each file single-responsibility (< ~200 lines). Use `showAppToast`/`toast` for test-connection and download feedback.

- [ ] **Step 3: Typecheck** — `npm --prefix web-ui run typecheck`.

- [ ] **Step 4: Build** — `npm --prefix web-ui run build` (catches lazy-import/chunk issues; CodeMirror must stay its own chunk — it already is via `CodeEditorLazy`).

- [ ] **Step 5: Commit**

```bash
git add web-ui/src/components/storage/
git commit -m "feat(storage): web-ui StorageView (sidebar, browser, viewer, dialog)"
```

---

### Task 13: web-ui — mount the Storage surface (App + TopBar + control button + URL)

**Files:**
- Modify: `web-ui/src/App.tsx` (state ~112, resets ~120/654/665, toggle ~674, TopBar props ~1019, render branch ~1072)
- Modify: `web-ui/src/components/top-bar.tsx` (props ~329/384, render ~590)
- Create: `web-ui/src/components/storage/storage-control-button.tsx` (mirror `database-control-button.tsx`)
- Modify: `web-ui/src/hooks/app-utils.tsx` (add `?storage` parse/build helpers if the other overlays are URL-routed; if Database is NOT URL-routed, match that — keep parity with Database's mechanism)
- Modify: the vault-settings web hook (add `setAgentStorageAccessEnabled` mirroring `setAgentDatabaseAccessEnabled` — grep for it)

- [ ] **Step 1: Add `StorageView` lazy import + `isStorageOpen` state** in `App.tsx`:

```tsx
const StorageView = lazy(() =>
	import("@/components/storage/storage-view").then((module) => ({ default: module.StorageView })),
);
// ...
const [isStorageOpen, setIsStorageOpen] = useState(false);
```

- [ ] **Step 2: Reset `isStorageOpen` alongside the others** (the project-switch handler ~120, and each other toggle's reset ~654/665, plus add `setIsStorageOpen(false)` inside `handleToggleVault`/`handleToggleDatabase`/`handleToggleGitHistory`), and add the toggle:

```tsx
const handleToggleStorage = useCallback(() => {
	if (hasNoProjects) return;
	setIsGitHistoryOpen(false);
	setIsVaultOpen(false);
	setIsDatabaseOpen(false);
	setIsStorageOpen((current) => !current);
}, [hasNoProjects]);
```

Also add `setIsStorageOpen(false)` into `handleToggleVault`, `handleToggleDatabase`, `handleToggleGitHistory`, and the project-switch reset.

- [ ] **Step 3: Extend the render branch** (~1070):

```tsx
) : isDatabaseOpen ? (
	<DatabaseView workspaceId={currentProjectId} />
) : isStorageOpen ? (
	<StorageView workspaceId={currentProjectId} />
```

- [ ] **Step 4: Pass TopBar props** (~1019, mirror the Database block):

```tsx
onToggleStorage={hasNoProjects || selectedCard ? undefined : handleToggleStorage}
isStorageOpen={isStorageOpen}
agentStorageAccessEnabled={vaultSettings.agentStorageAccessEnabled}
onAgentStorageAccessChange={(next) => void vaultSettings.setAgentStorageAccessEnabled(next)}
storageSettingsDisabled={vaultSettings.isLoading || vaultSettings.isMutating}
```

- [ ] **Step 5: Add the props to TopBar + render the button** (`top-bar.tsx`, mirror lines 329/384/590):

```tsx
// params
onToggleStorage, isStorageOpen, agentStorageAccessEnabled, onAgentStorageAccessChange, storageSettingsDisabled,
// types
onToggleStorage?: () => void;
isStorageOpen?: boolean;
agentStorageAccessEnabled?: boolean;
onAgentStorageAccessChange?: (next: boolean) => void;
storageSettingsDisabled?: boolean;
// render (next to DatabaseControlButton)
{!hideProjectDependentActions && onToggleStorage ? (
	<StorageControlButton
		isStorageOpen={isStorageOpen === true}
		onToggleStorage={onToggleStorage}
		agentStorageAccessEnabled={agentStorageAccessEnabled ?? false}
		onAgentStorageAccessChange={onAgentStorageAccessChange ?? (() => {})}
		settingsDisabled={storageSettingsDisabled}
	/>
) : null}
```

- [ ] **Step 6: Create `storage-control-button.tsx`** — copy `database-control-button.tsx`, swap the `Database` icon for `lucide-react`'s `HardDrive` (or `Cloud`), label "Storage", and reword the access-switch copy: label "Allow agents to read object storage", description on/off (note: v1 has no agent path, so keep copy accurate — "Reserved for a future agent read path; today this gates the Storage view for this workspace."). If you prefer to omit the agent-access half in v1, render only the toggle button (simpler and honest). **Recommended: render only the toggle button in v1** (no agent popover), since there is no agent S3 path yet — the `agentStorageAccessEnabled` field still exists for the future.

- [ ] **Step 7: Add `setAgentStorageAccessEnabled` to the vault-settings web hook** — grep `grep -rn "setAgentDatabaseAccessEnabled\|agentDatabaseAccessEnabled" web-ui/src` and add the storage peer (calls `runtime.updateVaultSettings`/whatever the DB one calls with `{ agentStorageAccessEnabled: next }`).

- [ ] **Step 8: Typecheck + build** — `npm --prefix web-ui run typecheck && npm --prefix web-ui run build`.

- [ ] **Step 9: Commit**

```bash
git add web-ui/src/App.tsx web-ui/src/components/top-bar.tsx web-ui/src/components/storage/storage-control-button.tsx web-ui/src/hooks/app-utils.tsx web-ui/src/**/use-*vault*.ts
git commit -m "feat(storage): mount Storage surface in App + top-bar control"
```

---

### Task 14: Live verification (MinIO) + docs

**Files:**
- Create: `.plan/docs/s3-object-storage-browsing-manual-test.md` (MinIO recipe)
- Modify: `AGENTS.md` (one tribal-knowledge note)
- Modify: `README` / docs index if the repo documents surfaces there (grep for where Database is documented)

- [ ] **Step 1: Full test suite** — `bun vitest run test/runtime/storage/` (all green) and `npx vitest run test/runtime/storage/` (CI parity on Node — proves the fake seam works without Bun).

- [ ] **Step 2: Typecheck both libs** — `npm run typecheck && npm --prefix web-ui run typecheck`.

- [ ] **Step 3: MinIO live smoke** (documented, not CI). Write `.plan/docs/s3-object-storage-browsing-manual-test.md`:

```md
# Manual test: S3 storage browsing against MinIO

1. Run MinIO: `docker run -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"`
2. Create a bucket `assets` + upload a text file, an image, and a >1 MB text file (console at :9001, creds minioadmin/minioadmin).
3. In Kanban, open the Storage surface → Add connection:
   - endpoint `http://localhost:9000`, region `us-east-1`, bucket `assets`, virtualHostedStyle OFF (path-style), accessKeyId/secretAccessKey `minioadmin`.
4. Test connection → expect ok + latency.
5. Browse: folders (commonPrefixes) render; double-click descends; breadcrumb ascends; Load more appears past 1000 keys.
6. Preview: text renders in CodeMirror; image renders inline; the >1 MB text file shows "too large → download"; download works.
7. Confirm read-only: there is no create/rename/delete/upload affordance anywhere in the surface.
```

Then run it once by hand with `bun src/cli.ts` from the repo root (no `--project-path`).

- [ ] **Step 4: Add the AGENTS.md note** — one paragraph:

> **S3 object-storage browsing is a dedicated read-only "Storage" surface (`src/storage/`, `components/storage/`), NOT part of Database or file-surface.** It mirrors the DB subsystem's connection model (sharded secret-free records under board-data home; secrets in machine-home `~/.kanban/settings/storage-credentials.json` 0600 via `KANBAN_STORAGE_CREDENTIALS_PATH`; peer access-gate field `agentStorageAccessEnabled`) and reuses file-surface's CodeMirror/binary presentation. `Bun.S3Client` is **bucket-scoped with no ListBuckets**, so a connection pins one bucket and the tree navigates prefixes via `delimiter:"/"`. Read-only is **structural** — `StorageService` exposes no write/delete/presign. The Bun client is behind an injectable `S3ClientFactory` (`src/storage/s3-client.ts`, `Bun.S3Client` referenced lazily via the global, mirroring `bun-sql.ts`) so vitest injects a fake on Node; real coverage is `bun test`/MinIO. Credentials are always explicit (never Bun's `S3_*`/`AWS_*` env fallback). Downloads stream base64 through the backend — no presign URL reaches the browser.

- [ ] **Step 5: Update MEMORY** — add a one-line pointer + a memory file (see brainstorming/agents memory conventions).

- [ ] **Step 6: Commit**

```bash
git add .plan/docs/s3-object-storage-browsing-manual-test.md AGENTS.md
git commit -m "docs(storage): S3 browsing tribal-knowledge note + MinIO manual test"
```

---

## Self-Review

**Spec coverage:**
- §1 placement (dedicated surface) → Tasks 12–13. ✓
- §2 bucket-scoped/explicit creds/list semantics → Tasks 2,3,4,5. ✓
- §3 backend `src/storage/` → Tasks 1–5. ✓
- §4 data contract → Task 6. ✓
- §5 tRPC + download-through-backend → Tasks 8,10 (`downloadObject`). ✓
- §6 access gate → Task 9 (+ UI in Task 13). ✓
- §7 web-ui presentation reuse + single-level browser → Tasks 11,12. ✓
- §8 testing (fake seam, vitest + Bun/MinIO) → every backend task + Task 14. ✓
- §9 docs → Task 14. ✓
- §10 out-of-scope (no write/presign/list-buckets) → enforced structurally (Task 5) + no procedures added for them. ✓

**Placeholder scan:** the only intentional "paste from sibling" points are (a) `TEXT_EXTENSIONS` in Task 3 (with a verify step) and (b) exact web-ui import paths in Tasks 11–13 (with explicit grep/read steps first). No "TODO/handle edge cases" hand-waves; all backend code is complete.

**Type consistency:** `StorageConnectionRecord`, `StorageCredential`, `ResolvedS3ClientOptions`, `S3ClientLike`, `StorageEntry`, `StorageObjectContent`, and the `Runtime*` contract names are used identically across tasks. `normalizeConnId` is exported from the store and imported under the alias `normalizeStorageConnId` in `workspace-state.ts` to avoid colliding with the DB store's same-named export. tRPC procedures call the api methods on `ctx.workspaceApi` (merged type), matching the DB wiring.

**Open confirmations the implementer must resolve by reading (not guessing):** how `createWorkspaceApi` spreads the DB api (Task 10 Step 1); the exact `useTrpcQuery` import path and `@runtime-contract` alias (Task 11 Step 1); the file-surface icon/CodeMirror export names (Task 12 Step 1); the vault-settings web hook setter (Task 13 Step 7); whether overlays are URL-routed (Task 13 Step for `app-utils.tsx`).
