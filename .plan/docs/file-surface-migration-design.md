# Migrating Files out of Vault → the first-class File surface

Status: **design only** (no implementation in this task)
Scope: web-ui (`web-ui/src`). **No backend changes, no new tRPC, no contract changes.**
Companion to `.plan/docs/file-surface-design.md` (which shipped Phase 1 — the markdown single-doc overlay) and `.plan/docs/vault-file-quick-dialog-design.md` (the seed dialog). This doc is the **migration + 撤销** step: pull the *binary file library* out of Vault and give it a home under the already-first-class File surface, so Vault no longer carries any "Files".

---

## 0. TL;DR

- Today, **two unrelated "files" things** exist: (1) the **markdown vault documents** — already served by the first-class **File surface** overlay (`components/file-surface/`, commit `0fd8442d`); (2) the **binary file library** (`components/files/FilesView`, blobs via Git LFS) — still **parasitic inside `VaultView`**, reachable only through the Vault sidebar's *Library → All files* entry.
- This task removes #2 from Vault. The binary library leaves the Vault sidebar entirely; Vault keeps **only** typed documents (Requirements, Customer, Decision, Note) + vault types. The File surface becomes the single first-class home for *both* "files" senses.
- **The migration is presentation/entry-level, not a physical relocation.** `components/files/` is already a neutral top-level module (sibling of `vault/`, not nested in it) and is *also* consumed by a genuine Vault feature (`vault/customer/customer-materials.tsx`). So `components/files/` **stays put as a shared file-domain library**; what changes is *who renders its `FilesView` shell and via what entry* — Vault stops, the File surface starts.
- **Performance is the load-bearing constraint.** Inside `VaultView`, the library is a board-*replacing* full-page (board unmounts/remounts on every toggle — `fullscreen-toggle-slow-board-unmount-fix`). After migration it renders as a **portaled overlay over a never-unmounted board**, exactly like the markdown overlay. We *improve* the library's perf by moving it, never reproduce the trap.
- v1 is a **subtraction from Vault + a thin additive face on the File surface**: cheap, low-risk, mostly deletes coupling.

---

## 1. Current state — verified inventory

### 1.1 The two "files" senses (don't conflate)

| Sense | Module | Data | tRPC | Entry today | UI weight today |
|---|---|---|---|---|---|
| **Markdown vault document** | `components/file-surface/` (overlay) + `components/vault/` (browse) | `files/docs/<type>/<slug>-<id>.md`, editable text | `workspace.getDocument`/`updateDocument`/`createDocument`/`listDocuments`/`searchDocuments`/`getDocumentLinks`; type `RuntimeVaultDocument` | top-bar **File** button (palette overlay) + Vault sidebar *Documents* | light (overlay) for single open; heavy (Vault) for browse |
| **Binary file library** | `components/files/` (`FilesView`, `useFileLibrary`, …) | `files/blobs/<id>/<name>` via Git LFS, upload/preview only | `workspace.listFiles`/`addFile`/`updateFile`/`deleteFile`/`getFileBytes`; types `RuntimeFileItem` / `RuntimeFilesListResponse` | **only** Vault sidebar *Library → All files* | **heavy** (rendered inside board-replacing `VaultView`) |

This task is about **moving sense #2 out of Vault**. Sense #1's single-doc overlay is already first-class; its *browse* (typed boards/tables) is the part that legitimately **stays** in Vault.

### 1.2 Where Vault currently exposes the binary library

Exact sites (verified):

- `web-ui/src/components/vault/vault-view.tsx`
  - `:5` `import { FilesView } from "@/components/files/files-view";`
  - `:20` `export type VaultInitialView = "files" | "requirements";`
  - `:22–27` `selectionFromInitial()` — maps `"files"` → `{ kind: "files" }`
  - `:43` `initialView: VaultInitialView` prop
  - `:46`, `:52–55` `selection` state seeded from / re-pointed by `initialView`
  - `:218–219` `selection.kind === "files" ? <FilesView workspaceId={workspaceId} /> : …`
- `web-ui/src/components/vault/vault-sidebar.tsx`
  - `:1` `import { Files, Search } from "lucide-react";` (the `Files` icon)
  - `:10` `export type VaultSelection = { kind: "type"; type: string } | { kind: "files" };`
  - `:16` `isSameSelection()` — the `a.kind === "files"` branch
  - `:84–92` the entire *Library / All files* sidebar section
- `web-ui/src/App.tsx`
  - `:1053` `<VaultView workspaceId={currentProjectId} initialView="requirements" />` — the **only** call site; already passes `"requirements"`, so the `"files"` branch is currently *dead at the top level* and reachable only by clicking the sidebar item.

> Note: there is **no top-bar "Files" button and no `isFilesOpen` App state** anymore (a prior refactor already collapsed the top-bar Files entry into Vault-as-requirements). The binary library's *only* live entry today is the Vault sidebar's *All files* item. This makes the 撤销 narrow.

### 1.3 The coupling that must keep working

`web-ui/src/components/vault/customer/customer-materials.tsx` imports **low-level pieces** of the binary library:

- `:6` `formatFileSize` from `@/components/files/file-meta`
- `:7` `FileThumbnail` from `@/components/files/file-thumbnail`
- `:8` `useFileLibrary` from `@/components/files/use-file-library`

A customer's "materials" panel lists that customer's uploaded binary files. **This is a real Vault-domain feature that depends on the file-library data hook + thumbnail/meta primitives.** It is the decisive reason `components/files/` **stays as a shared module** and is *not* absorbed-and-hidden inside `file-surface/`.

### 1.4 The already-shipped File surface (what we build on)

`components/file-surface/` (Phase 1, `0fd8442d`) — overlay peer to Vault/Database:
- `file-surface-store.ts` — module singleton `{fileId, workspaceId, paletteOpen}` + `?file=<id>` URL routing.
- `file-surface-provider.tsx` — mounts overlay + palette as **portaled siblings** over `children` (board by reference → never re-renders on open); `React.lazy` for `FileOverlay` + `FileQuickOpen`.
- `use-open-file.ts` — `useOpenFile()` seam + `useFileSurfaceActive()` (leaf subscription for the top-bar ring).
- `file-overlay.tsx` + `use-file-doc.ts` — single markdown doc view/edit (`getDocument`/`updateDocument`).
- `file-quick-open.tsx` + `use-file-recents.ts` — palette (`searchDocuments`, capped) + recents.
- Top-bar **File** button (`top-bar.tsx`) → `fileSurfaceStore.openPalette()`; active ring via `useFileSurfaceActive()` read **in the TopBar fiber**.

---

## 2. Target product boundary

After migration, three peer surfaces with a crisp boundary:

| Surface | Mental model | Holds | Entry | Weight |
|---|---|---|---|---|
| **Vault** | "My typed knowledge base." | Markdown docs with frontmatter: Requirements, Customer, Decision, Note + vault types, board/table/filters/saved-views/backlinks. **No files library.** | top-bar **Vault** (→ documents) | heavy (full-page, unchanged) |
| **Database** | "External SQL store." | Connections, schema tree, row grids. | top-bar **Database** | heavy (full-page, unchanged) |
| **File** | "Files — raw files & a quick single-doc lane." | (a) the **binary file library** (browse/upload/preview/rename/delete), (b) **single markdown doc** quick-open/view/edit. | top-bar **File** | **light (overlay)** |

The fuzzy edge — "a markdown doc is also a file" — is resolved by **intent**: Vault is for *curating typed knowledge* (you live in the board/table); File is for *raw blobs + "just show me this one file now"*. The File surface is allowed to open a markdown doc (single-doc lane) without that doc leaving Vault's library — they share the same underlying `RuntimeVaultDocument` store.

---

## 3. Migration checklist

### 3.1 撤销 from Vault — delete/edit points

**`vault-view.tsx`** (the core decoupling):
- Remove `import { FilesView }` (`:5`).
- Remove the `VaultInitialView` `"files"` member; the type collapses to a single mode. **Recommended:** drop the `initialView` prop entirely (its only value is now `"requirements"`) and hardcode the initial selection to `{ kind: "type", type: "requirement" }`. Delete `selectionFromInitial()` and the `useEffect` that re-points on `initialView` change (`:52–55`).
- Remove the `selection.kind === "files"` branch (`:218–219`); the render reduces to `view ? <VaultContent/> : <unknown type/>`.
- `VaultSelection` becomes effectively `{ kind: "type"; type: string }` — but it's owned by the sidebar (next).

**`vault-sidebar.tsx`:**
- Narrow `VaultSelection` to `{ kind: "type"; type: string }` (`:10`); simplify `isSameSelection()` (`:16`) to a plain `type` compare.
- Delete the entire *Library / All files* section (`:84–92`).
- Drop the now-unused `Files` icon import (`:1`); keep `Search`.
- Remove the `onOpenSearch`-adjacent dead refs if any.

**`App.tsx`:**
- `:1053` becomes `<VaultView workspaceId={currentProjectId} />` (prop removed). No other App change for Vault — the `isVaultOpen` flag, `handleToggleVault`, the mutually-exclusive zeroing, and the reset-on-task/project-switch effects all stay (Vault is still a board-replacing surface; only its *contents* shrank).

**Net effect:** `VaultView` no longer imports anything from `components/files/`. The only remaining `components/files/` importer is `customer-materials.tsx` (§1.3), which is untouched and keeps working.

### 3.2 Files↔Requirements decoupling — confirmation

Files and Requirements "share one VaultView" only via the `VaultSelection` union + the `selection.kind === "files"` fork. Removing the `"files"` variant **is** the decoupling — there is no shared data hook between them (`useFileLibrary` vs `useVaultDocs` are already separate). After §3.1, `VaultView` is purely a typed-document browser. Requirements (and customer/decision/note) are unaffected: they never touched the files branch.

**Regression to verify:** the customer anchor flow (`customer-materials.tsx` → `useFileLibrary`) still renders a customer's binary materials — this is the one place a Vault screen still reads the file library, and it does so through the **shared low-level module**, not through `FilesView`/`VaultView`. It must continue to work unchanged.

### 3.3 What moves to the File surface

Nothing physically relocates in v1. The File surface **gains an entry + a presentation face** for the existing `components/files/FilesView`:
- `components/files/` stays as the shared file-domain library (data hook, list, detail, thumbnail, meta, bytes, upload utils).
- The File surface renders `FilesView` inside its **overlay**, lazy-loaded.

(Optional later tidy, not v1: if we want `components/files/` to read as "owned by File", move it under `components/file-surface/library/` and re-point `customer-materials.tsx`'s three imports. This is pure churn with a vault→file-surface import; **deferred** unless the ownership story demands it. Recommended: leave `components/files/` where it is — neutral and already correctly placed.)

---

## 4. File surface architecture after migration

### 4.1 Two content modes in one lightweight overlay shell

The File surface keeps its **single portaled-overlay-over-mounted-board** model and hosts two modes:

- **Library mode** — the migrated `FilesView`: browse / upload / drag-drop / preview / rename / delete binary files. This is the new home for what was Vault's *All files*.
- **Document mode** — the existing single markdown doc overlay (`file-overlay.tsx`): view / edit one `.md` doc.

Plus the existing **quick-open palette** (`searchDocuments`) for jumping to a markdown doc.

Both modes are portaled siblings of `children`; the board is never unmounted or resized.

### 4.2 Entry & routing

- **Top-bar File button** (`top-bar.tsx`, exists). Behavior choice (recommended default):
  - Click → open the File surface in **Library mode** (the binary library browse), since that is the capability being rehomed and the one users previously reached via *All files*. The quick-open palette remains available *within* the surface (e.g. a search affordance / `⌘K` while the surface is open) for jumping to a markdown doc.
  - *Alternative considered:* keep the button opening the palette (today's behavior) and put "Browse all files" as an item inside it. Rejected as the default because the rehomed capability (the library) deserves the direct entry; the palette is a power-user jump.
- **Routing** (extends the existing `?file=` convention in `file-surface-store.ts` + `app-utils.tsx`):
  - `?file=<id>` → Document mode for that markdown id (**unchanged**).
  - Library mode → add a lightweight flag, e.g. `?files` (no id) or `?file=library` sentinel. Recommended: a boolean `paletteOpen`-style `libraryOpen` in the store, optionally URL-reflected as `?files`. Keep it additive and independent of `?task=`/`?chat=`, same as `?file=`.
- **Active ring**: `useFileSurfaceActive()` already returns true when the overlay/palette is open; extend its snapshot to also cover Library mode. Read **in the TopBar fiber** only (never threaded from App) — the non-negotiable perf rule.

### 4.3 Module structure

```
components/file-surface/
  file-surface-provider.tsx   // mounts overlay + palette + (NEW) library, portaled over children
  file-surface-store.ts       // + libraryOpen flag; URL sync unchanged for ?file=
  use-open-file.ts            // useOpenFile() seam + useFileSurfaceActive() (extended)
  file-overlay.tsx            // single markdown doc view/edit          (Document mode)
  use-file-doc.ts
  file-quick-open.tsx         // searchDocuments palette
  use-file-recents.ts
  file-library-overlay.tsx    // NEW thin wrapper: portaled shell + <FilesView/> (Library mode)
  index.ts

components/files/             // SHARED file-domain library (UNCHANGED location)
  files-view.tsx              // rendered by file-library-overlay (was rendered by VaultView)
  use-file-library.ts         // also used by vault/customer/customer-materials.tsx
  file-list.tsx, file-detail-panel.tsx, file-thumbnail.tsx,
  file-meta.tsx, use-file-bytes.ts, file-upload-utils.ts
```

`file-library-overlay.tsx` is the only genuinely-new component: a `React.lazy` overlay shell (Radix Dialog / `fixed inset` portal) that mounts `<FilesView workspaceId=…/>` on open and unmounts on close. It does **not** reimplement the library — it wraps the existing `FilesView`.

### 4.4 Public API (unchanged shape)
- `FileSurfaceProvider` (mounted high in `App.tsx`, wrapping main content as `children`).
- `useOpenFile()` — open a single markdown doc by id (Document mode). Unchanged seam.
- `fileSurfaceStore.openPalette()` / `.openLibrary()` (NEW) / `.closeAll()`.
- `useFileSurfaceActive()` — for the top-bar ring.

### 4.5 Shared vs File-owned

| Layer | Owner | Notes |
|---|---|---|
| Binary library data hook + primitives (`use-file-library`, `file-meta`, `file-thumbnail`, `use-file-bytes`, `file-upload-utils`, `file-list`, `file-detail-panel`) | **Shared** (`components/files/`) | Also consumed by Vault's `customer-materials`. Do **not** hide inside file-surface. |
| `FilesView` browse shell | **Shared**, *presented by* File surface | Was presented by Vault; now by `file-library-overlay`. |
| Library/Document overlay shells, entry, routing, recents, palette | **File surface** | The "ownership" the migration confers. |
| `DocEditor` (`vault/editor/`) | **Shared** (stays in vault) | Markdown editor with the ghosting fix; File surface reuses it (no `wikilinks` prop). |
| Wikilink resolution (`vault/links/`) | **Shared** (vault-domain) | Triggers belong to callers; File surface only consumes `useOpenFile`. |
| Document CRUD + Files CRUD tRPC | **Shared backend** (`workspace` router) | No change — see §6. |

---

## 5. Performance — how this dodges the Vault/Database trap (point-by-point)

The whole reason to move the library is that *inside Vault it is a board-replacing full-page* (`App.tsx` swaps `<VaultView>` for `<KanbanBoard>`), so every open/close unmounts and remounts the entire board (`fullscreen-toggle-slow-board-unmount-fix`). Moving it to the overlay model **eliminates** that.

| Pitfall (library inside Vault today) | Library in File surface |
|---|---|
| Board **unmounts** when you open the library (Vault replaces board) | Board **stays mounted**; library is a portaled sibling. |
| Board **full remount** on close (`content-visibility` cards re-paint) | Nothing — board was never touched. |
| Heavy Vault shell (sidebar + type sources + relation fetches) mounts just to reach files | Only `file-library-overlay` + `FilesView` + one `listFiles` query. |
| View-switch re-renders App content region | `openLibrary()` flips store state in the provider's own fiber; `children` element reference unchanged → board bails out (the established §5.4 rule from `file-surface-design`). |
| No code-splitting | `file-library-overlay` + `FilesView` are `React.lazy` — not in first paint. |
| Surface lost on refresh | Optional `?files` flag survives refresh. |

Additional rules carried over (non-negotiable):
- Open/close state lives **inside the provider fiber**, never in `App`.
- Top-bar active ring reads via **leaf `useSyncExternalStore` subscription**, never threaded from App.
- `listFiles` is the library's only standing query (it already is — `useFileLibrary`); the library never blocks first paint.

---

## 6. Data flow & type ownership

**No backend change. No new tRPC. No contract change.**

| Mode | Procedures | Types |
|---|---|---|
| Library | `workspace.listFiles`, `addFile`, `updateFile`, `deleteFile`, `getFileBytes` | `RuntimeFileItem`, `RuntimeFilesListResponse` (`api-contract.ts:443/458`) |
| Document | `workspace.getDocument`, `updateDocument`, `searchDocuments` (+ `createDocument` later) | `RuntimeVaultDocument` |

Both slices already live in the **`workspace` tRPC router** (`app-router.ts`; `listFiles` `:1026`, file CRUD `:1035–1063`, document CRUD `:1065–1099`) → `workspace-api.ts`. They are **cleanly separated procedures** sharing one router; the File surface simply consumes both. The library is **not** part of the `workspace-state` save payload (it's backend-source-of-truth, fetched on demand) — so moving its UI doesn't touch state sync. Edits broadcast `workspace_state_updated` as today.

No DB-style separate sub-router is warranted: unlike `database` (external connections needing their own policy/connection model), files are already first-class `workspace` procedures. Mirroring `database`'s separate router would be churn for no isolation benefit.

---

## 7. Compatibility & triggers — where files open from after migration

Every "open a file" path funnels through the File surface; no caller keeps a Vault dependency.

| Trigger | Status | After migration |
|---|---|---|
| **Chat wikilink** (`[[link]]`) | shipped | `ChatWikilinkProvider` (in `vault/links/`) → `useOpenFile(id)` → Document mode. Unchanged. |
| **Top-bar File button** | exists | → Library mode (§4.2) (was: palette). |
| **`?file=<id>` URL** | exists | Document mode. Unchanged. |
| **Vault *All files* sidebar item** | **removed** | Gone from Vault. Its capability is the top-bar File → Library mode. |
| **Customer materials** (`customer-materials.tsx`) | unchanged | Still reads `useFileLibrary` directly (shared module); renders inline in the customer panel. *Not* routed through the overlay (it's an embedded list, by design). Optionally, a "thumbnail click → open in File surface preview" can call a future `openFile`-for-binary seam (Phase 2, §8). |
| Card-detail / board-card / db-cell file refs | future | Same `useOpenFile` / `openLibrary` seam; no Vault coupling. |

Binary-file preview via the **single-file overlay** (so a blob opens in the same lane as a markdown doc) is a **Phase 2** unification (the overlay learns a binary branch using `getFileBytes`), not required for v1 — v1's Library mode already previews binaries via `FileDetailPanel`.

---

## 8. Phasing & rollback

### v1 (this delivery) — subtract from Vault, add the library face
1. **Vault 撤销** (§3.1): delete the `"files"` branch from `vault-view.tsx` / `vault-sidebar.tsx`; drop `initialView` from the `App.tsx` call. Vault becomes documents-only.
2. **File surface Library mode** (§4): add `file-library-overlay.tsx` (lazy) rendering the existing `FilesView`; add `fileSurfaceStore.openLibrary()` + extend `useFileSurfaceActive()`; point the top-bar File button at Library mode (palette still reachable within the surface).
3. **Routing** (optional but recommended): `?files` flag for refresh-survival.
4. Verify `customer-materials` and Requirements still work; verify no dead `components/files` import remains in `vault/` except `customer/`.
- **Deliverable:** Vault carries no Files; the binary library is a first-class, overlay-light File capability; zero backend change.

### Phase 2 — unify the single-file lane
- Single-file overlay learns a **binary branch** (`getFileBytes` preview/download) so `openFile(id)` works for blobs too; `customer-materials` thumbnails → `openFile`.
- Frontmatter editing in Document mode (already planned in `file-surface-design` Phase 2).

### Phase 3 — reach & tidy
- Card-detail / board-card / db-cell triggers.
- (Optional) physically move `components/files/` under `file-surface/library/` and re-point `customer-materials` — pure ownership tidy, no behavior change.
- (Optional, separate) migrate `VaultView`/`DatabaseView` themselves to mount-but-hide using these lessons.

### Rollback & regression risk
- **Lowest-risk part:** the Vault subtraction is mechanical deletion of a self-contained union branch; if it regresses, it's a compile error, not a silent break (the `VaultSelection` narrowing makes the dead `"files"` paths fail typecheck if missed).
- **Watch points:**
  1. `customer-materials.tsx` must **not** be touched and must keep importing from `components/files/` — the single surviving Vault→files coupling. A regression here breaks the customer materials list.
  2. The `⌘K` quick-open hotkey is currently registered **inside `VaultView`** (`vault-view.tsx:86–101`, scoped to when Vault is mounted). The File surface palette is the board-level analog — confirm no hotkey collision when neither surface is open, and that removing the files branch doesn't disturb the vault-scoped hotkey registration.
  3. The top-bar File button's *meaning changes* (palette → library). Confirm wikilink/`?file=` Document-mode entries are unaffected (they bypass the button).
  4. `useFileSurfaceActive()` must light for Library mode too, else the ring lies.
- **Rollback:** revert is a single web-ui commit (no migrations, no backend, no on-disk format change). The binary library data, blobs, and tRPC are untouched throughout — only which component mounts `FilesView` changes.

---

## 9. Decisions taken (recommended defaults; flag if you disagree)

1. **`components/files/` stays put as a shared module** — not absorbed into `file-surface/` — because `customer-materials` (a real Vault feature) depends on it. The File surface owns *entry + presentation*, not the files implementation. *(Recommended; physical move deferred to Phase 3.)*
2. **Library renders as a portaled overlay**, never a board-replacing page — mandated by the perf requirement. *Locked.*
3. **Top-bar File button → Library mode** by default (the rehomed capability gets the direct entry); palette remains reachable within the surface. *(Flag if you'd rather keep palette-first.)*
4. **No backend / tRPC / contract change** — both file and document slices already exist on the `workspace` router. *Locked.*
5. **`VaultInitialView` and the `{kind:"files"}` `VaultSelection` variant are deleted**, narrowing Vault to documents-only — the type system enforces the decoupling. *Locked.*
6. **Optional `?files` URL flag** for the library (refresh-survival), independent of `?file=`/`?task=`/`?chat=`. *(Recommended; can ship without it.)*
7. **Binary-in-single-overlay unification is Phase 2**, not v1 — v1's Library mode already previews binaries via the existing `FileDetailPanel`. *(YAGNI for v1.)*
