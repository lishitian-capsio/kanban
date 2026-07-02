# S3-Compatible Object Storage — Read-Only Browsing (Design)

Date: 2026-07-02
Status: Approved design, pre-implementation

## 1. Problem & Placement Decision

Add a read-only browser for S3-compatible object storage (AWS S3 / Cloudflare R2 /
DigitalOcean Spaces / MinIO / Supabase) built on Bun's native `Bun.S3Client`.

**The first decision was where it lives.** Three candidates were weighed:

| Option | Verdict |
| --- | --- |
| **(a) Database view, `engine=s3`** | Rejected. The Database subsystem is row/column-tabular to the core (`browseTable`, virtualized `data-grid` where each cell is a `{column: value}`, PK-based edit). S3 objects are not rows; forcing them into the grid loses tree navigation and real preview. Wrong paradigm. |
| **(b) Tab inside the Files library** (`?files=s3`) | Rejected. The `文件系统`/`上传` tabs' mental model is "the current workspace repo"; `workspace-fs-api.ts` is hardcoded to `scope.workspacePath` and has **no connection/credential concept**. Injecting a managed remote-connection model into it muddies the local-fs explorer, and the connection picker has no natural home. |
| **(c) Dedicated Storage surface** ✅ | **Chosen.** S3 browsing is *presentationally* a file browser but *operationally* a managed connection (a list of endpoint+bucket+credentials, like DB connections — unlike the workspace fs, which is just "the repo"). A dedicated surface lets each half sit where it belongs: reuse **file-surface's presentation** components + reuse **Database's connection-management / secret-storage / access-gate** patterns. |

**Chosen architecture:** a new peer overlay (mutually exclusive with Vault / Database /
GitHistory), toggled from the top bar. Presentation borrowed from file-surface; connection
management borrowed from the Database subsystem.

> Implementation note: the surface is opened via a local `isStorageOpen` `useState` in
> `App.tsx` (matching the sibling `isDatabaseOpen` mechanism), NOT a `?storage` URL param —
> Database is likewise not URL-routed, so this keeps the two surfaces consistent. (An earlier
> draft of this doc proposed a `?storage` query param; that was not shipped. A URL-routed
> deep-link could be added later for both surfaces together.)

## 2. Hard Constraint from the Bun API

`Bun.S3Client` (see `node_modules/bun-types/s3.d.ts`) is **bucket-scoped** and exposes
**no ListBuckets** operation. `client.list(input, options)` lists objects within one
configured bucket only. Therefore:

- A **connection = endpoint + region + bucket + credentials**. Listing buckets is **not
  offered** (unsupported by Bun, YAGNI).
- Hierarchical browsing uses `list({ prefix, delimiter: "/", maxKeys, continuationToken })`:
  `commonPrefixes[]` → folders, `contents[]` → objects, `isTruncated` +
  `nextContinuationToken` → pagination.
- This resolves the task's "列桶/对象": we list objects (with `commonPrefixes` as folders);
  the bucket is pinned on the connection.

Relevant Bun surface (confirmed in `s3.d.ts`):
- `new Bun.S3Client({ accessKeyId, secretAccessKey, sessionToken?, region?, endpoint?, bucket, virtualHostedStyle? })`
- `client.list(input?, options?) → S3ListObjectsResponse { contents?[{key,size?,lastModified?,eTag?}], commonPrefixes?[{prefix}], isTruncated?, nextContinuationToken?, keyCount? }`
- `client.file(key) → S3File extends Blob` — `.text()`, `.arrayBuffer()`, `.slice(begin,end)`, `.stream()`, `.stat()`, `.exists()`, `.presign()`
- `client.stat(key) → S3Stats { size, lastModified: Date, etag, type }`

> **Credentials must be explicit.** `Bun.S3Client` falls back to `S3_*` / `AWS_*` env vars
> when options are omitted. We **always** pass explicit `accessKeyId`/`secretAccessKey`/
> `endpoint`/`region`/`bucket` per connection and never rely on env fallback. v1 requires
> credentials (anonymous public-bucket read is a future extension).

## 3. Backend — `src/storage/` (mirrors `src/db/`)

### 3.1 Connection records & secrets — `src/storage/storage-connection-record.ts`

Mirrors `src/db/registry/connection-record.ts`.

```ts
// Committed, secret-free. Sharded one-file-per-connId under board-data home.
storageConnectionRecordSchema = z.object({
  connId: z.string().min(1),
  label: z.string().min(1),
  endpoint: z.string().nullable(),          // R2/MinIO/Spaces custom endpoint; null ⇒ AWS default
  region: z.string().nullable(),
  bucket: z.string().min(1),
  virtualHostedStyle: z.boolean().default(false), // false ⇒ path-style (MinIO); R2 ok either way
  createdAt: z.string(),                    // ISO; supplied by caller (no Date.now in pure code)
})

// Machine-home secret. Lives ONLY in ~/.kanban, never committed, never in --json.
storageCredentialSchema = z.object({
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  sessionToken: z.string().optional(),      // temporary STS creds
})
```

### 3.2 Store — `src/storage/storage-connection-store.ts`

Mirrors `connection-store.ts` exactly:
- `readConnections(shardDir)` / `writeConnections(shardDir, records)` — sharded JSON via
  `readShardDir`/`writeShardDir` (board-data home).
- `readCredentials(path)` / `writeCredentials(path, data)` — machine-home
  `~/.kanban/settings/storage-credentials.json` (0600; missing/torn ⇒ empty).
- `resolveS3Options(record, credential) → S3Options` — merge committed metadata + secret
  into the explicit Bun options object. Secret exists only in the returned in-memory object.

### 3.3 Injection seam — `src/storage/s3-client.ts`

The mock seam (mirrors `PoolManager.createDriver`). Bun.SQL/Bun.s3 are unavailable under
vitest (Node), so the service depends on a factory:

```ts
interface S3ClientLike {
  list(input: S3ListInput): Promise<S3ListObjectsResponse>;
  statObject(key: string): Promise<S3Stats>;
  readObject(key: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }>;
}
type S3ClientFactory = (opts: S3Options) => S3ClientLike;
// default factory wraps `new Bun.S3Client(opts)`; tests inject a fake.
```

The default factory is the ONLY place that touches `Bun.S3Client`. `readObject` uses
`file.slice(0, maxBytes).arrayBuffer()` so we never download an object larger than the cap.

### 3.4 Service — `src/storage/s3-service.ts`

`StorageService` (constructor takes `{ createClient: S3ClientFactory, loadConnections,
mutateConnections, loadCredential, mutateCredential, now }` — all injected, like the DB
service):

- `listConnections()` → records + `hasCredential` flag (secret never returned)
- `upsertConnection(input)` / `deleteConnection(connId)` — password behavior mirrors DB
  (string = set, null = clear, undefined = keep)
- `testConnection(connId)` → a `list({ maxKeys: 1 })` probe → `{ ok, latencyMs, error? }`
- `listObjects(connId, { prefix?, continuationToken?, maxKeys? })` → `RuntimeStorageListResult`
  (always `delimiter: "/"`)
- `readObject(connId, key)` → `RuntimeStorageObjectContent` (caps + binary classification)
- `statObject(connId, key)` → `RuntimeStorageStat`

**Read-only is structural, not policy-gated:** the service simply exposes no write/delete/
presign methods. (No SQL-style policy layer is needed — there is no ambiguous "is this a
write?" question.)

**Size caps & binary classification** (reuse the fs constants' semantics):
- text edit/preview cap 1 MB; binary preview cap 8 MB; over cap ⇒ `tooLarge: true`, no content.
- binary decided by `stat().type` (content-type) + a NUL sniff on the head bytes; the
  `TEXT_EXTENSIONS` landmine from `workspace-fs-api.ts` (`.ts` → `video/mp2t`) applies here
  too — reuse the same extension allowlist.

### 3.5 Download

`downloadObject(connId, key)` streams the object's bytes **through the backend** (like
`workspaceFs.downloadEntry`), base64 to the client, capped at 100 MB. We do **not** issue a
presign URL to the browser — that would leak a credentialed URL and is out of the read-only
v1 scope.

## 4. Data Contract — `src/core/api-contract.ts` (mirrors `RuntimeFsEntry`)

```ts
RuntimeStorageConnection  = { connId, label, endpoint, region, bucket, virtualHostedStyle, hasCredential, createdAt }
RuntimeStorageEntry       = { key, name, kind: "prefix" | "object", size?, lastModified?, etag? }
RuntimeStorageListResult  = { prefix, entries: RuntimeStorageEntry[], isTruncated, nextContinuationToken? }
RuntimeStorageObjectContent = { key, encoding: "utf8" | "base64", content?, size, lastModified, etag, contentType, binary, tooLarge }
RuntimeStorageStat        = { key, size, lastModified, etag, contentType }
```

`name` is the basename (last path segment after `/`); `key` is the full S3 key. For a
`prefix` entry, `key` is the `commonPrefix` (with trailing `/`).

## 5. tRPC — `src/trpc/workspace-storage-api.ts` (mirrors `workspace-db-api.ts`)

Procedures: `listConnections`, `upsertConnection`, `deleteConnection`, `testConnection`,
`listObjects`, `readObject`, `statObject`, `downloadObject`. Caller is fixed `"human"`.
Per-workspace service instance memoized via a `getWorkspaceStorageStack(workspaceId)`
(mirrors `workspace-db-service.ts` `getWorkspaceDbStack`). Wired into `app-router.ts` +
injected into `RuntimeTrpcContext` in `runtime-server.ts`.

> Dual-lib typecheck watch: the router type is reachable from web-ui's `trpc-client.ts`, so
> any DOM-ish type (`Blob`/base64 buffers) in a router-reachable file is checked twice.
> Copy bytes into a fresh `new Uint8Array(len)` before constructing anything DOM-like.

## 6. Access Gate — per-workspace switch

Add a same-shape peer to `vaultSettingsSchema` (`api-contract.ts`) alongside
`agentDatabaseAccessEnabled`:

```ts
agentStorageAccessEnabled: z.boolean().default(false)  // + optional() in the patch schema
```

Managed by `vault-settings-store.ts` (mirror the existing `agentDatabaseAccessEnabled`
patch branch). In v1 there is no agent/CLI S3 path, so this switch gates the human Storage
surface per workspace (the natural extension point for a future agent read path). Satisfies
the task's "保留 access gate 或等价的每工作区开关".

## 7. Web-UI — `web-ui/src/components/storage/`

- **`storage-view.tsx`** — container. Left: connection sidebar (list + add/edit/delete
  dialog, patterned on `database-sidebar.tsx` + `connection-dialog.tsx`). Right: object
  browser.
- **Object browser = breadcrumb + single-level list + Load More** (not a recursive
  virtualized tree). Rationale: S3 pagination is naturally "one page per prefix +
  `continuationToken`"; a single-level list maps to it directly and is simpler than forcing
  S3 into the recursive `FileTree`. Double-click a prefix to descend, breadcrumb to go up,
  `isTruncated` ⇒ a Load More affordance.
- **Right pane reuses file-surface presentation directly**: `CodeEditorLazy` (CM6),
  binary/image preview, `iconForFile` — these take content/props, not fs hooks.
- **New hooks (S3 semantics, not the fs hooks):** `use-storage-connections.ts`,
  `use-storage-tree.ts` (prefix navigation + continuation-token paging),
  `use-storage-object.ts` (fetch one object's content/stat).
- **Mount:** `isStorageOpen` mutually-exclusive overlay in `App.tsx` (1:1 with
  `isDatabaseOpen`: state ~line 112, reset alongside line 654/665, toggle ~line 674, render
  branch ~line 1072), `?storage` URL param (parse/build in `app-utils.tsx`), top-bar entry.

## 8. Testing

- **vitest (Node):** inject a fake `S3ClientFactory` into `StorageService`. Cover:
  connection-store roundtrip (sharded records + machine-home credentials, 0600), service
  `listObjects`/`readObject`/`statObject` against the fake, caps (`tooLarge`/truncated),
  text-vs-binary classification, read-only (assert no write/delete/presign method exists on
  the service), access-gate behavior.
- **Real Bun.s3:** a `bun test` roundtrip or a local **MinIO** container (documented, not in
  CI) — sticks to the existing "the real Bun driver can't be vitest-tested" convention from
  the DB subsystem.

## 9. Documentation

- This spec.
- One AGENTS.md tribal-knowledge note (placement decision, bucket-scoped constraint,
  explicit-credentials rule, injection seam, read-only-is-structural).
- One `~/.claude` memory entry.

## 10. Explicitly Out of Scope (v1)

Listing buckets; any write/delete/upload; presign (upload or download-to-browser); an
agent/CLI S3 read path; anonymous public-bucket access.

## 11. Component Boundaries (isolation check)

| Unit | Does | Depends on |
| --- | --- | --- |
| `storage-connection-record.ts` | zod schemas (record + credential) | zod only |
| `storage-connection-store.ts` | persist/merge records + secrets | sharded-json-store, locked-fs |
| `s3-client.ts` | Bun.S3Client wrapper + injection seam | Bun.S3Client (default factory only) |
| `s3-service.ts` | read-only ops + caps + classification | store + client factory (both injected) |
| `workspace-storage-api.ts` | tRPC surface, per-ws scoping | s3-service |
| `storage-view.tsx` + hooks | connection sidebar + object browser | tRPC client; reuses file-surface presentation |

Each unit is testable in isolation; the only Bun-native touch point (`s3-client.ts` default
factory) is behind an injectable interface.
