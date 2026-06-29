# File — a first-class surface (peer to Vault & Database)

Status: **design only** (no implementation in this task)
Scope: web-ui (`web-ui/src`) + a thin reuse of existing runtime tRPC. **No new backend paths in v1.**
Supersedes the framing of `.plan/docs/vault-file-quick-dialog-design.md` — that dialog is the *seed*; this doc grows it into a standalone surface.

---

## 0. TL;DR

- **File** becomes a top-level product surface alongside **Vault** and **Database**: it gets its own top-bar entry, its own URL route (`?file=<id>`), and its own self-contained module (`components/file-surface/`) that does **not** depend on `VaultView`.
- The defining product job is **single-file quick open / view / edit** — "I have a specific file, open it *now*", not "browse the whole library" (that stays Vault).
- **The peer-ness is in identity and entry, not in presentation.** Vault and Database are slow because they are board-*replacing* full-page views (board unmounts/remounts on every toggle — see `fullscreen-toggle-slow-board-unmount-fix`). File deliberately does the opposite: it presents as a **portaled overlay** over a board that never unmounts. First-class ≠ full-page.
- It reuses the genuinely-shared lower layers (tRPC document CRUD, `DocEditor`, wikilink resolution) and *owns* the overlay shell, the opener/provider, the quick-open palette, recent-files, and URL routing.
- v1 is mostly a **reorganization + two small additions** on top of the already-shipped quick dialog, so it is cheap and low-risk.

---

## 1. Why File stands alone — product boundary

Kanban already has three "document-ish" things; the boundary between them is the whole justification for a separate surface:

| Surface | Mental model | Granularity | Entry intent | UI weight |
|---|---|---|---|---|
| **Vault** | "My knowledge base." Typed docs (requirement/customer/decision/note) with board/table, filters, saved views, backlinks, type registry. | The **whole library** | "Let me browse/organize/curate everything." | Heavy (full-page) |
| **Database** | "An external SQL store." Connections, schema tree, row grids. | A **whole connection/table** | "Let me query/edit external data." | Heavy (full-page) |
| **File** *(new)* | "This one file." Open → read → tweak → close. | **One document** | "I have a reference (a `[[link]]`, a card mention, a recent edit) — show it to me without losing my place." | **Light (overlay)** |

The File surface exists because the single-file case is **disproportionately served by the library browser**. Today, to glance at one referenced file you either (a) pay a full `VaultView` mount (board unmount + list-all-docs-of-a-type + browse to it) or (b) use the quick dialog, which has no top-level presence, no URL, and no way to *start* from "I want to open a file" (it only reacts to wikilink clicks). The File surface closes that gap: a first-class, fast lane for the atomic unit of the vault — the single document.

### 1.1 Relationship to the binary file library (`FilesView`)

There are, confusingly, **two** "files" in the codebase today:

1. **Markdown vault documents** — `workspace.getDocument/updateDocument`, stored at `files/docs/<type>/<slug>-<id>.md`. **Editable text.** This is what the File surface is about.
2. **The binary file library** — `web-ui/src/components/files/files-view.tsx` + `useFileLibrary`, blobs via Git LFS at `files/blobs/<id>/<name>`, surfaced inside the Vault sidebar's "All files". **Upload/preview/rename/delete binaries**, no editing.

**v1 scopes the File surface to markdown documents** (the editable single-file case). The binary library is a different interaction (upload-and-preview) and stays where it is. Unifying them — letting the same overlay preview a binary or open a doc — is a clean **Phase 3** extension (§9), not v1. Naming note: we keep the surface called "File" (singular, "open a file") and leave the plural binary "Files" library under Vault for now; if the overlap confuses users later, the binary library can move *into* the File surface as its "browse" affordance.

---

## 2. Architecture thesis: first-class ≠ full-page

This is the load-bearing decision, so it gets its own section.

A naive reading of "peer to Vault and Database" is: add `isFileOpen` boolean state to `App.tsx`, add a top-bar button, and render `<FileView>` in the same mutually-exclusive conditional that swaps out `<KanbanBoard>`. **We explicitly reject that**, because it reproduces the exact performance trap the task calls out:

> `App.tsx ~1049–1065`: `{isVaultOpen ? <VaultView/> : isDatabaseOpen ? <DatabaseView/> : isGitHistoryOpen ? <GitHistoryView/> : <KanbanBoard/>}`

Every toggle into/out of those branches **unmounts and remounts the entire board** (columns/cards rebuilt, `content-visibility: auto` cards re-paint). That is the documented root cause behind `fullscreen-toggle-slow-board-unmount-fix` (fixed there by keeping the board mounted-but-hidden) and the motivation for the original quick dialog.

Instead, the File surface is **additive and ephemeral**: a Radix-portaled overlay layered over a board that is never removed from the tree or resized. It is "first-class" because it has:

- a **top-level entry** (top-bar button, §3),
- a **persistent identity in the URL** (`?file=<id>`, §4) — shareable, refresh-survivable, back/forward-navigable, which is *more* than Vault/Database have today (they're transient un-routed toggles),
- a **self-contained module** with a clear public API (§5),

…without paying any board mount/unmount cost. Peer status is about *entry and identity*; presentation is free to be lighter than the older surfaces. (If anything, this is the pattern Vault/Database *should* migrate toward later — out of scope here.)

---

## 3. Top-level entry & navigation wiring

### 3.1 Today's pattern (what we mirror for the entry, diverge from for the body)

- **Top-bar buttons** live in `web-ui/src/components/top-bar.tsx`: Vault (`~567–575`, a split toggle) and Database (`~576–587`, a simple toggle). Each calls an `onToggle*` callback prop.
- **State** is three mutually-exclusive booleans in `App.tsx` (`~112–114`): `isVaultOpen`/`isDatabaseOpen`/`isGitHistoryOpen`, with toggle handlers (`~636–662`) that zero the others.
- These surfaces are **not URL-routed** — they reset on refresh.
- By contrast, **task detail** (`?task=`) and **fullscreen chat** (`?chat=`) *are* URL-routed via helpers in `web-ui/src/hooks/app-utils.tsx` and a `history`-API navigation hook.

### 3.2 The File entry

Add a **File** top-bar button (Lucide `FileText`/`File` icon) next to Database. But its handler does **not** flip a board-replacing boolean. It opens the File surface in one of two modes:

- **No file chosen yet** → open the **quick-open palette** (§6): a lightweight searchable picker (`workspace.searchDocuments`, server-ranked, capped) to choose a file, plus a recent-files shortlist. Selecting a result calls `openFile(id)`.
- **Direct id** (wikilink/card/recents) → `openFile(id)` opens the editor overlay immediately, skipping the palette.

So the top-bar button is the "I want to open *a* file, help me find which" entry; every other trigger is "open *this* file". Both converge on the same `openFile(id)` seam.

The button is gated like the others (`!hasNoProjects`). Active styling (`ring-1 ring-accent`) reflects "an overlay is open", read from the provider — see §5 for why this must not re-render the board.

### 3.3 Routing convention

Follow the `?task=` / `?chat=` precedent exactly. Add to `app-utils.tsx`:

```ts
const FILE_QUERY_PARAM = "file";
parseFileIdFromSearch(search): string | null
buildFileUrl({ pathname, search, hash, fileId }): string
```

and a small `useFileSurfaceNavigation()` hook (mirroring the existing detail/fullscreen-chat nav hooks) that:
- seeds the open file from `?file=<id>` on load,
- pushes/replaces `?file=<id>` when a file opens, clears it on close,
- supports back/forward (closing via browser-back).

This gives File surface **URL-persistence the older surfaces lack**, and makes a single file shareable (`/<project>?file=<id>`). `?file=` composes with `?task=`/`?chat=` (it's an independent param); precedence/stacking rules: the file overlay layers above whatever is behind it (board, or a task detail), since it's a portal.

---

## 4. Data flow & type ownership

**No new backend in v1.** All vault document CRUD already lives in the unified `workspace` tRPC router (`src/trpc/app-router.ts ~1065–1142` → `workspace-api.ts` → `VaultDocumentStore`). The File surface consumes a deliberately **narrow** slice:

| Need | Procedure | Why this one |
|---|---|---|
| Open one file | `workspace.getDocument` `{ id }` → `{ document }` | Single read. **Never `listDocuments`** (that loads all docs of a type — the heavy browsing concern we're avoiding). |
| Save edits | `workspace.updateDocument` `{ id, title?, body? }` (patch) | Patch semantics — frontmatter round-tripped untouched, no corruption, no merge logic in v1. |
| Quick-open palette | `workspace.searchDocuments` `{ query, limit }` | Server-ranked, capped. Cheaper and more relevant than client-filtering an all-docs list. |
| (Phase 2) properties | `workspace.updateDocument` `{ id, frontmatter }` | Same patch endpoint, orthogonal field. |

**Identifier is the file `id`** (uuid, surfaced in frontmatter as `_id`) — stable across branch switches, unlike `relativePath`. The surface opens, routes, and recents-tracks by `id`.

**Type ownership:** zero new contract types for v1. `RuntimeVaultDocument` and the request/response schemas already live in `src/core/api-contract.ts` and reach web-ui via the `@runtime-contract` alias (`web-ui/src/runtime/types.ts`). The only new *frontend-local* state is the recent-files list (§6.1), which is a `string[]` of ids in `localStorage` — not a wire type.

Persistence path is unchanged: `getDocument`/`updateDocument` → `VaultDocumentStore` → `files/docs/...` under `resolveBoardDataLocation` (committed board data; board-branch decoupling transparent). Edits broadcast `workspace_state_updated` exactly as the dialog does today.

---

## 5. Module structure & public API

Extract the existing `vault/quick-dialog/` into a **neutral, vault-independent** module. This formalizes the already-planned extraction (memory `vault-file-quick-dialog-implemented`: "EXTRACTED to neutral components/file-dialog/"; on this worktree it is still `vault/quick-dialog/` with `Vault*` names — v1 does the rename).

```
web-ui/src/components/file-surface/
  file-surface-provider.tsx   // mounts the overlay + owns {open,fileId,workspaceId} + URL sync; provides useOpenFile
  use-open-file.ts            // the opener seam: useOpenFile() -> (id, opts?) => void   (was useOpenVaultFile)
  file-overlay.tsx            // the Radix Dialog shell: header + DocEditor + save/close + dirty-guard  (was vault-file-dialog.tsx)
  use-file-doc.ts             // single-doc read/save by id via workspace.getDocument/updateDocument  (was use-vault-file-doc.ts)
  file-quick-open.tsx         // top-bar-triggered palette: search + recents -> openFile(id)
  use-file-recents.ts         // recent-file ids in localStorage (frontend-only)
  index.ts                    // public exports: FileSurfaceProvider, useOpenFile
```

### 5.1 What the surface OWNS
- The overlay shell and its lifecycle (mount-on-open / unmount-on-close).
- The opener seam (`useOpenFile`) and provider state.
- The quick-open palette + recents.
- URL routing for `?file=`.

### 5.2 What it REUSES (shared, not copied)
- `components/vault/editor/doc-editor.tsx` — `DocEditor` (the `@uiw/react-md-editor` wrapper with the ghosting fix; see `md-editor-ghosting-fix` — must **not** re-instantiate `MDEditor` directly or ghosting regresses). Genuinely shared by vault detail, this overlay, and future CLI/chat editors.
- `components/ui/dialog.tsx` — `Dialog`/`DialogHeader`/`DialogBody`/`DialogFooter`, with `contentClassName` to size the overlay (e.g. `max-w-3xl w-[90vw] h-[80vh]`).
- tRPC document CRUD (the `workspace` slice above).
- **Wikilink resolution** lower layer (`components/vault/links/` + backend `vault-link-index.ts`). Resolution is a shared service; the *triggers* are the callers' concern (§7).

### 5.3 What stays in vault (domain-specific, NOT moved)
- `chat-wikilink-provider.tsx` / `chat-wikilink-context.ts` — these are vault-domain (they build a candidate resolver from vault docs). They *consume* `useOpenFile` but belong under `vault/links/`. Moving them out of `quick-dialog/` (into `vault/links/`) is part of the cleanup; they do **not** enter `file-surface/`.
- All browsing UI: `VaultView`, `VaultContent`, `VaultSidebar`, board/table/filters/saved-views/detail/properties — untouched. The File surface never imports `VaultView`.

### 5.4 The "don't re-render the board" rule (perf-critical wiring)
`FileSurfaceProvider` mounts **high in `App.tsx`** (where `VaultFileDialogProvider` is today, `App.tsx ~892`), wrapping the main content as `children`:

```tsx
<FileSurfaceProvider workspaceId={currentProjectId}>
  {/* existing main content incl. KanbanBoard, unchanged element reference */}
</FileSurfaceProvider>
```

- Open/close state lives **inside the provider's own fiber**, never in `App`.
- The context value is the **stable, memoized `openFile` function** — consumers that read only the opener never re-render when a file opens.
- `children` is passed as a prop, so when the provider re-renders on open, React keeps the same `children` element reference and the board subtree bails out of re-render. (This is the established rule from `perf10-runtime-store-selectors`: high-frequency state stays in the leaf fiber that shows it — here the "leaf" is the overlay.)
- The top-bar "active" ring (§3.2) therefore must read open-state via a **selector/subscription that lives in the top-bar fiber**, not by threading `isFileOpen` down from `App` (which would re-render the tree). Cheapest: a tiny `useFileSurfaceOpen()` reading the provider's state with `useSyncExternalStore`, subscribed inside `TopBar`.

---

## 6. The quick-open palette (the one genuinely-new piece)

The dialog today can only be *opened by id*. To be a startable surface, File needs a "pick a file" entry. Keep it lightweight:

- A `Dialog` (or command-palette style) that, on the top-bar entry, shows:
  - a search box → `workspace.searchDocuments({ query, limit: ~20 })` (debounced; server-ranked snippets),
  - a **recents** shortlist when the query is empty.
- Selecting a result → `openFile(id)` → palette closes, editor overlay opens.
- Bind to an existing hotkey convention if desired (the vault already uses `Ctrl+K` quick-open *within* vault; the File surface palette is the board-level analog — confirm we don't collide, or reuse the same key when no surface is open).

This deliberately **reuses `searchDocuments`** rather than `listDocuments`, so even the picker never loads the whole library.

### 6.1 Recents
`use-file-recents.ts`: a `localStorage`-backed `string[]` of recently-opened ids (per workspace), pushed on every `openFile`. Frontend-only, no backend, no wire type. Gives the palette a useful zero-query state and reinforces the "fast lane" product feel.

---

## 7. Triggers & the `useOpenFile` seam

Every way to open a file funnels through `openFile(id, { workspaceId? })`. Existing and planned callers:

| Trigger | Status | Wiring |
|---|---|---|
| **Chat wikilink** (`[[link]]` in home/task chat) | **Shipped** (commit `24c8ed1b`) | `ChatWikilinkProvider` binding `onOpen: (res) => openFile(res.id)`. Just re-points to the renamed `useOpenFile`. |
| **Top-bar File button** | New (§3.2) | Opens palette → `openFile(id)`. |
| **`?file=<id>` URL** | New (§3.3) | Nav hook seeds `openFile` on load. |
| **Card-detail markdown wikilinks** | Extension | Needs a resolver binding on that surface (a shared cached resolver backed by `searchDocuments`/`listDocuments`); then same `onOpen`. |
| **Board card "open referenced file"** | Extension (Phase 3) | Card affordance calls `openFile(id)` directly (id known, no resolver needed). |
| **Database cell referencing a doc** | Extension | Same opener. |

The seam is the integration contract: **any surface that can produce a file `id` can light up File-open with one hook call**, with zero coupling to vault browsing.

---

## 8. How this dodges every Vault/Database perf pitfall (point-by-point)

| Pitfall (Vault/Database today) | File surface |
|---|---|
| Board **unmounts** on open (conditional swaps `<KanbanBoard>` out) | Board **stays mounted**; overlay is a portaled sibling. Never swapped. |
| Board **full remount** on close (`content-visibility` cards re-paint) | Nothing — board was never touched. |
| Heavy UI mounts on entry (list + table/board + detail + all-docs hooks) | One `Dialog` + one `DocEditor` + one `getDocument`. Editor is **lazy-loaded** (code-split) so it's not in first paint. |
| Network on open = `listDocuments` (all docs of a type) | `getDocument` (one doc). Palette uses capped `searchDocuments`, never list-all. |
| View switch re-renders the App content region | Opener is a stable fn; `children` element reference unchanged → board bails out of re-render (§5.4). |
| Mount/unmount of heavy UI on every toggle | Only the overlay mounts/unmounts, on open/close. |
| No code-splitting discipline | `file-surface/` is lazy-imported; editor lazy within it (consistent with `web-ui-render-perf-fixes` P0). |
| Surface lost on refresh | `?file=` survives refresh and is shareable. |

Net: open/close is near-zero board cost, the editor's memory is released on close, and first paint is unaffected.

---

## 9. Phasing

### Phase 1 — Surface-ify the dialog (small, low-risk)
Mostly reorganization + two additions.
1. Extract `vault/quick-dialog/` → `components/file-surface/`; rename `Vault*`→`File*` (`VaultFileDialogProvider`→`FileSurfaceProvider`, `useOpenVaultFile`→`useOpenFile`, `useVaultFileDoc`→`useFileDoc`, etc.). Move `chat-wikilink-*` into `vault/links/`.
2. Add **URL routing** (`?file=`) in `app-utils.tsx` + `useFileSurfaceNavigation()`.
3. Add the **top-bar File button** + the **quick-open palette** (§6) with recents (§6.1).
4. Re-point the chat-wikilink binding to `useOpenFile` (one-line).
- Deliverable: File is a startable, URL-routed, top-level surface for single markdown docs. No board-replacement, no `VaultView` dependency.

### Phase 2 — Editing depth
- Frontmatter/properties editing in the overlay (reuse `VaultPropertiesPanel`, same `updateDocument` patch with `frontmatter`).
- In-overlay wikilink navigation (pass a `wikilinks` binding to `DocEditor` whose `onOpen` re-points `fileId`, with the dirty-guard) + a small back-stack.
- Create-from-surface (`workspace.createDocument` already exists): an "open or create" opener variant.

### Phase 3 — Reach & unification
- Card-detail + board-card + database-cell triggers (needs the shared cached resolver for surfaces lacking one).
- **Binary file unification**: let the overlay preview a binary library file (`workspace.getFileBytes`) so "open a file" covers blobs too; potentially fold the binary library's browse UI in as the File surface's "all files" affordance, retiring its place in the Vault sidebar.
- (Optional, separate) migrate `VaultView`/`DatabaseView` to mount-but-hide using the lessons here.

---

## 10. Decisions taken (recommended defaults; flag if you disagree)

1. **Overlay, not board-replacing full-page** — mandated by the perf requirement; this is the core thesis (§2). *Locked.*
2. **Scope = markdown documents** for v1; binary library stays separate (Phase 3 unification). (§1.1)
3. **Module name `components/file-surface/`** (neutral, vault-independent), aligning with the planned `file-dialog` extraction but at surface scope. Public API = `FileSurfaceProvider` + `useOpenFile`.
4. **Quick-open uses `searchDocuments`** (capped/ranked), never `listDocuments`. (§6)
5. **URL-routed (`?file=`)** — File gets persistence the older surfaces lack. (§3.3)
6. **Save model** carried over from the dialog: explicit Save + commit-on-blur, dirty-guard on close.
7. **Top-bar active state via a leaf subscription**, never threaded from `App` (§5.4) — non-negotiable for the perf goal.
