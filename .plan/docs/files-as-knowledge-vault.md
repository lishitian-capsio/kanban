# Files → Unified Git-Backed Knowledge Vault — Design

> Status: **Design only** (no implementation). Sibling to `requirement-items-design.md`.
> Author context: 2026-06-12. Supersedes the standalone Requirements subsystem design.

## Context

Kanban has two separate spec surfaces:

- **Files** library — `<repo>/.kanban/files/` with a `files.json` manifest + hashed `blobs/<id>/<name>` (Git LFS), mime classification, repo-relative `getPath`/base64 `getBytes`. Self-contained tRPC + CLI + a first-class web-ui tab.
- **Requirements** subsystem — sharded `requirement-store` (`requirements/`, `requirement-versions/`, `requirement-task-links/`) with a **delivery-flavored** `draft/active/done/archived` status, an unused `source: human|agent` annotation, and version-history/revert machinery.

**North Star.** *Requirements face the customer; tasks face the result — opposite directions, so they have zero linkage.* A requirement should hold only what disappears if you delete the conversation. That makes it just a **markdown document**. Generalize that: a requirement is one **document type** in a unified, git-backed, Notion/Obsidian-style **knowledge vault**, and the existing Files library is the substrate.

**Outcome.** A type-agnostic document engine (markdown + YAML frontmatter + `type:`) shipping the **Requirement** type first, where adding the next type (Customer, ADR/Decision, Spec, Note/minutes, Reference, Roadmap) = a type-definition doc + a view, nearly free. Borrow conventions from the user's own vault app **tolaria** (`/home/developer/code/tolaria`) — frontmatter, `type:` as collection/schema, `template`, saved-views, `[[wikilinks]]` — **without integrating or depending on it**; identical `.md` format leaves interop open. Kanban contributes the long pole tolaria lacks: **table + board views** powered by its own kanban engine.

**Confirmed decisions (user):**
- **Navigation:** one **Vault surface, two entry points** — top-bar `Files` opens the All-files view; `Requirements` opens the `type:Requirement` board. Left rail switches types/saved-views.
- **Markdown editor:** `@uiw/react-md-editor` (one new dep; its preview delegates to the existing `KanbanMarkdownContent` renderer; constrain its CSS to dark tokens).
- **Vault root:** keep `<repo>/.kanban/files/`, add a `docs/` subtree. No path migration for existing blobs.

---

## Architecture at a glance

One vault directory, **two channels**:

```
<repo>/.kanban/files/
  .gitattributes            # existing: blobs/** via LFS; docs/** stay plain committed text
  files.json                # manifest for BINARY BLOBS ONLY (RuntimeFileItem[]) — unchanged
  blobs/<id>/<name>         # existing binary channel — unchanged
  docs/                     # NEW readable document channel (plain .md, real git diffs)
    <type>/<slug>-<id>.md   # e.g. requirement/login-rate-limit-a1b2c.md
    _types/<TypeName>.md     # type-definition docs (type: Type) — icon/label/template/statusEnum
  views/<name>.yaml         # NEW saved views (tolaria convention) — DEFERRED past MVP
```

- **Docs are scanned, not manifested** (tolaria model): frontmatter `_id`/`type` is the source of truth, so no index can drift. **Binaries keep `files.json`** (no parseable header; manifest carries mime/category/size).
- **Filename `<slug>-<id>.md`:** human-meaningful slug for navigability + stable `_id` suffix so lookups never depend on the slug and renames produce meaningful diffs.
- **Engine is type-agnostic and permissive:** unknown types are store-and-served; per-type frontmatter validation is opt-in via a small code-side registry. Requirement is the only registered type in MVP.

**Boundaries — kept OUT of the vault:**
- **Tasks** — board, independent `tasks/<id>.json` storage. A requirement→task link is a one-way frontmatter ref only; the task/board schema is never touched.
- **Runtime / secrets / index** — `~/.kanban`, machine-local.
- **Raw session logs** — `messages.jsonl` is a log, not a doc; storage untouched. (Crystallize *reads* the transcript to produce a doc; it does not move the journal into Files.)

---

## Current state (ground truth from exploration)

### Files library
- `src/files/file-library-store.ts` — `FileLibraryStore` over `<repo>/.kanban/files/`; methods `list/get/add/rename/remove/getBytes/getPath/ensureGitConfig`; locked via `lockedFileSystem.withLock`; ids via `createUniqueTaskId`. Mime in `src/files/file-mime.ts`.
- Contract `RuntimeFileItem {id,name,mime,category,size,addedAt}` + `RuntimeFilesData` + request/response family in `src/core/api-contract.ts` (~lines 290–384).
- tRPC `listFiles/getFile/addFile/updateFile/deleteFile/getFileBytes/getFilePath` in `src/trpc/workspace-api.ts` + `src/trpc/app-router.ts`; CLI in `src/commands/file.ts`.
- web-ui `web-ui/src/components/files/`: `files-view.tsx` (first-class tab), `use-file-library.ts` (self-contained tRPC hook), `use-file-bytes.ts`, `file-list.tsx`, `file-detail-panel.tsx`, `file-thumbnail.tsx`, `file-upload-utils.ts` (FileReader→base64, 100MB cap, `useDropArea`).

### Requirements
- `src/state/requirement-store.ts` on `src/state/sharded-json-store.ts`; orchestration/load/save/migration in `src/state/workspace-state.ts` (`saveWorkspaceState`, `mutateWorkspaceState`, `migrateRequirementsToShards`, `resolveRepoPathForWorkspaceId`).
- Contracts: `RuntimeRequirementItem {id,title,description,priority(low/medium/high/urgent),status(draft/active/done/archived),linkedTaskIds,order,createdAt,updatedAt}`; `RuntimeRequirementVersion {requirementId,version,changeKind,snapshot,source(human/agent),reason,createdAt}`; `RuntimeRequirementTaskLink {requirementId,taskId,source,createdAt}`.
- Logic in `src/core/requirement-mutations.ts`, `src/core/requirement-versions.ts` (incl. `diffRequirementVersions`), `src/core/requirement-task-link-mutations.ts`. tRPC `loadRequirementVersions`. CLI `src/commands/requirement.ts`.
- web-ui `web-ui/src/components/requirements/`: list + detail only (**no board, no task-link UI**); `requirement-version-history.tsx` (read-only, shows Human/Agent); revert is CLI-only. Pure state in `web-ui/src/state/requirements-state.ts`.

### Dead/unused paradigm
- `status` includes `draft/active` but there is **no review/approval flow**; `source: human|agent` is recorded but never drives logic; agent-driven reconcile is explicitly **not wanted** (memory: human-driven CRUD + link/unlink only). No customer field exists (a known gap).

### tolaria conventions to borrow (reference only)
- Plain `.md` + YAML frontmatter as source of truth (parsed with `gray-matter`); `type:` selects collection/schema; type-def doc has `type: Type` carrying icon/color/sidebar_label/template/sort; `[[wikilink]]` in any frontmatter field or body is a relationship; system fields are `_`-prefixed; saved-views are YAML in `views/` (name/icon/sort/filters with all|any + field/op/value); flat-at-root, type from frontmatter. **Tolaria is graph-first with NO table/board views — that is the gap kanban fills.**

### Existing web-ui assets to reuse
- `react-markdown@10.1.0` + `remark-gfm@4.0.1` are already deps; `web-ui/src/components/detail-panels/kanban-markdown-content.tsx` (`KanbanMarkdownContent`, GFM + Prism, token-styled) is a ready preview renderer.
- `@hello-pangea/dnd@18` powers the task board (`kanban-board.tsx`, `board-column.tsx`) — its dnd recipe is the reusable asset (not the task-coupled components).
- `react-virtuoso`, `fzf`, `react-use`, `sonner`, Radix popover — all present.

---

## Backend design

### New engine modules (pure, vitest-safe — no agent-sdk imports)

`src/vault/vault-document.ts` — in-memory model + pure functions:
- `parseVaultDocument(raw, relPath): VaultDocument` (wraps `gray-matter`).
- `serializeVaultDocument(doc): string` — **deterministic key order** so writes are diff-stable.
- `extractWikilinks(value): string[]` — any frontmatter field/body containing `[[...]]` is a relationship.
- `slugify(title): string`.
- Model: `VaultDocument { id, type, frontmatter: Record<string, VaultFrontmatterValue>, body, relativePath }`; system fields `_id/_created/_updated/_slug`.

`src/vault/vault-types.ts` — `vaultTypeRegistry: Record<type, VaultTypeDefinition>` mapping a type → optional Zod frontmatter schema + `defaultFrontmatter` + `slugField` + display metadata. **MVP registers only `requirement`.** This is the "nearly-free new type" seam.

`src/vault/vault-document-store.ts` — `VaultDocumentStore`, mirroring `FileLibraryStore`'s shape/locking, over `docs/`:
- `list(type?)`, `get(id)`, `create({type,title,body?,frontmatter?})`, `update(id, patch)` (merge frontmatter; re-slug + git-rename on title change, all inside the lock), `remove(id)`, `ensureGitConfig()`.
- **Reuse:** `createUniqueTaskId` (`src/core/task-id.ts`); `lockedFileSystem.withLock` + `writeTextFileAtomic` (content-compare skips no-op writes) from `src/fs/locked-file-system.ts`; the **same directory lock as the blob channel** so doc + blob mutations serialize; scan-and-skip-torn-file crash tolerance (from `sharded-json-store.ts` / the board shard reader).

New dependency: **`gray-matter`** (bundles `js-yaml`) — not currently present. Do not reimplement a YAML parser.

### Requirement = document (lifecycle reshape)

Frontmatter (MVP), with **description moved into the markdown body**:

```yaml
---
_id: a1b2c
type: requirement
title: Rate-limit login endpoint
status: proposed            # PROBLEM states: proposed 在提 | clarified 已澄清 | parked 搁置 | invalid 失效
priority: high              # low | medium | high | urgent (reuse existing priority enum)
customer: "[[acme-corp]]"   # wikilink ref to a Customer doc (plain string until Customer type lands)
related_tasks: [task-7f3a9] # one-way refs to board tasks (replaces task-links shard + linkedTaskIds)
_created: 1739000000000
_updated: 1739000000000
---
<markdown body = the requirement description>
```

- **Status reshape:** delivery-flavored → PROBLEM states. Migration map (intentionally lossy, documented): `draft→proposed`, `active→clarified`, `done→clarified`, `archived→parked`.
- **Version history → git.** Retire `requirement-versions/` shards + `diffRequirementVersions`/`appendRequirementVersion`/`revertRequirementToVersion` + the `loadRequirementVersions` tRPC. History is `git log -p docs/requirement/...` (a `getDocumentHistory` endpoint shelling git log is a later task).
- **`source: human|agent` disappears** (only existed to annotate versions).
- **Requirement↔task links** → the one-way `related_tasks` frontmatter array on the doc. Retire the `requirement-task-links/` shard channel.

### Contract changes (`src/core/api-contract.ts` — shared to web-ui via `@runtime-contract`; gates `web:typecheck`)

**ADD** (additive; the binary `RuntimeFileItem` path is untouched):
- `runtimeVaultDocumentSchema = { id, type, title, body, frontmatter: record(value), relativePath, createdAt, updatedAt }` + `runtimeVaultFrontmatterValueSchema` (string|number|boolean|null|array).
- list/get/create/update/delete request+response schemas mirroring the `runtimeFile*Request` family.
- `runtimeRequirementProblemStatusSchema = z.enum(["proposed","clarified","parked","invalid"])`.

**REMOVE (sequenced — see Risks):** `runtimeRequirement{Version,VersionsData,VersionsRequest,VersionsResponse,ChangeSource,TaskLink,TaskLinksData}`, the old `runtimeRequirementStatusSchema(draft/active/done/archived)`, `linkedTaskIds`/`order`, and `requirements`/`requirementTaskLinks` from `runtimeWorkspaceStateResponseSchema`/`SaveRequest`.

### tRPC + CLI

- `src/trpc/workspace-api.ts` + `src/trpc/app-router.ts`: ADD `listDocuments(type?)/getDocument/createDocument/updateDocument/deleteDocument` over `new VaultDocumentStore(workspaceScope.workspacePath)`, broadcasting `broadcastRuntimeWorkspaceStateUpdated` on mutation (same as `addFile`). REMOVE `loadRequirementVersions`. `loadState` stops returning `requirements`/`requirementTaskLinks`; web-ui self-fetches docs (as the Files panel already does).
- `src/commands/requirement.ts` → rewrite as thin `src/commands/vault.ts` (`doc list/show/create/update/delete`, `doc link/unlink` editing `related_tasks`); drop `history`/`revert`.
- `src/prompts/append-system-prompt.ts`: rewrite the Requirements section to describe `vault doc` commands; drop history/revert/link-task docs.

### Migration & retirement

- New `migrateRequirementsToVaultDocs(repoPath, workspaceId)` in `src/state/workspace-state.ts`, called from `prepareRepoRuntimeHome` **after** `migrateRequirementsToShards`, mirroring its idempotent + cheap-precheck + workspace-dir-lock pattern: skip if `docs/requirement/` exists or no requirement data present; else read existing requirements + links, write each as a `.md` doc (description→body, status remap, links→`related_tasks`, preserving original `_id`/timestamps), then **delete** the `requirements/`, `requirement-versions/`, and `requirement-task-links/` shard dirs (versions retired; git is the new record).
- `.gitattributes`: no change — `blobs/** filter=lfs` already scopes LFS; `docs/**` are plain committed text. `.kanban/.gitignore` denylist already commits new subdirs.
- **Retire (after migration + frontend rebuild):** `src/state/requirement-store.ts`, `src/core/requirement-versions.ts`, `src/core/requirement-task-link-mutations.ts`, `src/core/requirement-mutations.ts` (fold into store), the requirement read/write/version/link/migrate helpers + the `diffRequirementVersions` call in `saveWorkspaceState`, plus the contract types above.

---

## Frontend design (`web-ui/src/components/vault/`)

**Navigation (confirmed):** `App.tsx` renders one `VaultView` for both the Files and Requirements toggles (`isFilesOpen`/`isRequirementsOpen` stay as the toggle, passing `initialView`). `top-bar.tsx` buttons re-point at it.

**Component tree (new):**
- `vault/vault-view.tsx` — top-level surface; owns `selectedDocId` + active view-spec.
- `vault/vault-sidebar.tsx` — left rail (~260px): type list (Requirement, Customer, All files) + saved views.
- `vault/vault-content.tsx` — header (table/board toggle via `react-use` `useToggle` + lucide `Table`/`LayoutGrid`, filters, `+ New`) + table|board|detail.
- `vault/data/use-vault-docs.ts`, `use-vault-types.ts` — self-contained tRPC hooks cloned from `use-file-library.ts` (`getRuntimeTrpcClient`, mutate-then-refetch). `vault/data/frontmatter.ts` + `vault-doc-model.ts` — client-side YAML split/parse (add **`yaml@^2`**, gated to this module) → `VaultDoc = { id, type, name, frontmatter, body }`.
- `vault/views/vault-table-view.tsx` + `vault-table-row.tsx` — rows = docs of type; columns from the type's property schema (Requirement: Title/Status/Priority/Customer/Updated); `react-virtuoso`. Move `StatusBadge`/`PriorityDot`/`RequirementSelect` out of `requirements/requirement-meta.tsx` into `vault/views/vault-property-controls.tsx`.
- `vault/board/{vault-board,vault-board-column,vault-board-card}.tsx` + `vault-status-columns.ts` — **fork, don't reuse** the task board. Lift only the `@hello-pangea/dnd` `DragDropContext`/`Droppable`/`Draggable` recipe into a generic presentation-only board: `props { columns:{id,title}[], cardsByColumn, onCardMove(docId,toColumnId), renderCard }`. Columns come from the frontmatter `status` enum (PROBLEM states) → type-generic from day one. Card move = patch `frontmatter.status` → save. Within-column order by `updatedAt` (fractional ranking deferred). Not importing `BoardColumn`/`BoardCard` (their ~30 task callbacks would force a thin-wrapper anti-pattern).
- `vault/editor/{doc-editor,doc-preview}.tsx` — `@uiw/react-md-editor` for the **body only**; preview delegates to `KanbanMarkdownContent`. Frontmatter is edited separately, so the editor can never corrupt it.
- `vault/detail/{vault-doc-detail,vault-properties-panel}.tsx` — replaces `requirement-detail-panel.tsx`; keeps its local-buffer + commit-on-blur pattern. Properties panel = Status/Priority/Customer + backlinks read-out.
- `vault/customer/{customer-picker,customer-backlinks,customer-materials}.tsx` — Customer is `type: Customer`; requirement references it via `frontmatter.customer` (Radix Popover + `fzf`). Backlinks computed client-side (scan loaded docs) in MVP. Materials reuse `file-thumbnail.tsx` + `use-file-bytes.ts`.
- `vault/crystallize/{crystallize-button,crystallize-dialog,use-crystallize.ts}` — entry in the home sidebar header (near `HomeThreadBar`); takes a span of the home chat (a slice of the existing unified `SessionMessage`/`KanbanChatMessage` transcript from `use-kanban-chat-session.ts` — **no new message model; raw journal logs not moved into Files**), renders it into templated markdown, lets the user pick type + edit in `doc-editor`, then creates a vault doc. tRPC shape: `workspace.crystallizeChatToDoc.mutate({ sessionId, fromMessageId, toMessageId, type }) → { doc }` (backend later; MVP ships "whole thread / last N" before per-message range selection).

**Dead UI to remove (after parity):** `requirements/requirement-version-history.tsx` (+ test), `use-requirement-versions.ts`, Human/Agent `SOURCE_LABELS`, `requirements-view.tsx`/`requirement-list.tsx`/`requirement-detail-panel.tsx`/`requirement-form-dialog.tsx`, `web-ui/src/state/requirements-state.ts`, `draft/active` review remnants. Keep `files-view.tsx` re-parented under `VaultView` as "All files".

---

## Milestones (parallelizable marked ∥)

**Backend**
- **B1 ∥** Engine core: add `gray-matter`; `vault-document.ts` + `vault-types.ts` (pure, unit-tested). No contract change.
- **B2 ∥** Contract additions: `runtimeVaultDocument*` + problem-status enum (additive; web:typecheck stays green).
- **B3** (needs B1+B2) Store: `vault-document-store.ts` over `docs/`; unit + integration tests (round-trip, scan, rename, concurrent lock).
- **B4** (needs B3) tRPC + CLI: document endpoints; `vault.ts` CLI; broadcasts.
- **B5** (needs B3) Migration: `migrateRequirementsToVaultDocs` in `prepareRepoRuntimeHome`; integration-tested from shard + single-file sources.
- **B6** (gate) Retirement: delete requirement-store/versions/links code, prune contract, rewrite prompt — coordinated with the frontend cut.

**Frontend** (Phase A depends on B4 landing or a mocked hook)
- **A** Vault scaffold + data layer (hooks, `frontmatter.ts`, add `yaml`; `vault-view`/`sidebar`/`content`; wire `App.tsx`).
- **B1f ∥** Table view + property controls. **B2f ∥** Detail + editor (add `@uiw/react-md-editor`). **C ∥** Board view. (All after A.)
- **E ∥** Templates + create flow (alongside B/C). **D** (after B+C) Customer anchor. **F** (after editor + backend crystallize) Crystallize.
- **G** (last) Dead-UI removal.

**Cross-cutting:** the contract cut (removing requirement version/link/status types) must land as one coordinated backend+frontend change with the migration — sequence it: remove version/link types first (only the deleted version-history component depends on them), then narrow the status enum, keeping a projected `RuntimeRequirementItem` only if a transition window is needed.

---

## Verification

- **Engine/store:** vitest on `vault-document`/`vault-document-store` — round-trip serialize→parse stability, scan skips torn files, rename produces git-mv, concurrent lock serializes. Migration integration test: seed old shards + single-file → run `prepareRepoRuntimeHome` → assert `docs/requirement/*.md` content, status remap, `related_tasks`, old shard dirs gone; re-run asserts idempotence.
- **CLI:** `kanban vault doc create/list/show/update/delete` round-trips against a temp repo with no runtime; assert real `.md` on disk + meaningful `git diff`.
- **Types:** `web:typecheck` green after each contract step (the gating check).
- **UI (manual / `run` skill):** launch app, open Files→Vault, switch to Requirement type, toggle table/board, drag a card across PROBLEM columns and confirm the doc's `status` frontmatter updates on disk, edit body and confirm preview matches `KanbanMarkdownContent`, set a customer via the picker and see the backlink on the Customer doc, crystallize a home-chat span into a doc.

## Risks

1. **web:typecheck coupling** — removing requirement contract types ripples into ~12 web-ui files; sequence the cut and keep a projection type during transition.
2. **`gray-matter` / `yaml` round-trip churn** — key reordering/quoting can dirty git diffs; use a deterministic serializer (canonical key order) and lean on `writeTextFileAtomic` content-compare.
3. **Board fork drift** — copy only the minimal dnd structure; write fresh tests (task board's `kanban-board.test.tsx` as reference).
4. **`@uiw/react-md-editor` theming** — ships its own CSS; constrain to dark tokens, point preview at `KanbanMarkdownContent`, no light-mode leak.
5. **Migration lossiness** — status remap (`done→clarified`) is intentional; idempotent guard on `docs/requirement/` prevents re-runs.
6. **Slug-rename safety** — write-new + rm-old inside the lock; `_id` suffix makes scan-recovery deterministic after a crash.
7. **Test harness** — keep the vault engine free of agent-sdk imports so it stays vitest-testable (agent-sdk touches `Bun.env` at import).
8. **Crystallize selection UX** — message-span selection over a streaming transcript is fiddly; ship "whole thread / last N" first.

---

## Affected / new files (quick index)

**New (backend):** `src/vault/vault-document.ts`, `src/vault/vault-types.ts`, `src/vault/vault-document-store.ts`, `src/commands/vault.ts`.
**Modified (backend):** `src/core/api-contract.ts`, `src/trpc/workspace-api.ts`, `src/trpc/app-router.ts`, `src/state/workspace-state.ts`, `src/prompts/append-system-prompt.ts`.
**Retired (backend):** `src/state/requirement-store.ts`, `src/core/requirement-versions.ts`, `src/core/requirement-task-link-mutations.ts`, `src/core/requirement-mutations.ts`, `src/commands/requirement.ts`.
**New (frontend):** `web-ui/src/components/vault/**` (view/sidebar/content, data hooks, views, board, editor, detail, customer, crystallize).
**Modified (frontend):** `web-ui/src/App.tsx`, `web-ui/src/components/top-bar.tsx`; `files-view.tsx` re-parented.
**Retired (frontend):** `web-ui/src/components/requirements/**`, `web-ui/src/state/requirements-state.ts`.
**Deps added:** `gray-matter` (backend), `yaml` + `@uiw/react-md-editor` (web-ui).
