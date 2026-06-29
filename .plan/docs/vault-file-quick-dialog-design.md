# Vault single-file quick dialog — design

Status: design only (no implementation in this task)
Scope: web-ui (`web-ui/src`), reusing existing runtime tRPC; **no new backend paths**

## 1. Motivation

Today the only ways to view/edit a vault file are the **full-page tab views**: `VaultView` and `DatabaseView`, mounted in `App.tsx` via a conditional that **unmounts `KanbanBoard` entirely**:

```tsx
// web-ui/src/App.tsx ~1028–1075
{isVaultOpen ? (
  <VaultView workspaceId={currentProjectId} initialView="requirements" />
) : isDatabaseOpen ? (
  <DatabaseView workspaceId={currentProjectId} />
) : isGitHistoryOpen ? (
  <GitHistoryView … />
) : (
  <KanbanBoard … />
)}
```

This is the exact pattern the *fullscreen-chat* work had to abandon (see memory `fullscreen-toggle-slow-board-unmount-fix` and the rationale comment at `App.tsx ~493–502`): unmounting the board tears down and rebuilds the entire column/card tree on every entry/exit, and the `content-visibility: auto` cards re-paint on the way back. The fullscreen-chat fix kept the board **mounted-but-hidden** (`visibility: hidden`) precisely to avoid this — but vault/database switching was never migrated and still pays the full remount cost both directions.

When a user just wants to **glance at, or quickly tweak, one referenced file** (e.g. from a `[[wikilink]]`), paying a whole-board unmount + a full vault browser mount is wildly disproportionate.

**This design takes the opposite shape: an overlay dialog.** The board never unmounts and never reflows; the dialog content mounts on open and unmounts on close. Open/close is near-zero cost.

## 2. First-version scope (deliberately narrow)

In scope:
- View + simple edit + save + close of **one** vault file.
- Opened by **file `id`** (the stable, branch-independent identifier — see §4).
- Editing: **title + markdown body**. Saved via the existing patch endpoint (frontmatter preserved untouched).
- Trigger: clicking a vault **wikilink / file reference** routes to the dialog (see §8).

Explicitly out of scope for v1 (kept out to stay lightweight):
- **No file list / browsing inside the dialog** — that is what would make it heavy again. Browsing stays in `VaultView`.
- No frontmatter/properties editing in v1 (the dialog only patches `body`/`title`; frontmatter is round-tripped untouched). Reusing `VaultPropertiesPanel` is a documented extension (§9).
- No in-dialog wikilink resolution/navigation in v1 (documented extension, §9).
- No multi-file tabs, no split view.

## 3. Component architecture

### 3.1 Why a Radix Portal Dialog (not an `absolute inset-0` overlay)

Two existing overlay mechanisms were considered:

| Mechanism | Where used today | Board impact | Fit |
|---|---|---|---|
| `Dialog` (`components/ui/dialog.tsx`, wraps `@radix-ui/react-dialog`) | all modals | Renders in a **Portal** as a DOM sibling of the app root; board stays mounted & untouched. Radix unmounts portal content when `open=false` (no `forceMount`). | **Chosen** |
| `absolute inset-0` overlay | `CardDetailView` (`App.tsx ~1120`) | Board stays mounted but the overlay is a child of the board's relative parent; needs that parent + manual mount gating. | Heavier than needed for one file |

The Radix `Dialog` gives us, for free, exactly the two properties we want:
1. **Board never unmounts / never reflows** — the dialog is a portaled sibling layered above via `z-50` + `bg-black/60` overlay. The board sits underneath unchanged (it isn't even resized, unlike fullscreen chat which reflows-then-hides).
2. **Content mounts on open, unmounts on close** — Radix tears down portal children when closed, so the markdown editor (and its memory) is released on close. No `forceMount`.

### 3.2 New components / files (proposed)

```
web-ui/src/components/vault/quick-dialog/
  vault-file-dialog-provider.tsx   // context provider + the single mounted <Dialog>
  vault-file-dialog.tsx            // dialog body: header, editor, footer (save/close)
  use-vault-file-dialog.ts         // useOpenVaultFile() opener seam (stable fn)
  use-vault-file-doc.ts            // fetch+save ONE doc by id via existing tRPC
```

Reused as-is (no changes):
- `components/ui/dialog.tsx` — `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter`. `Dialog` accepts `contentClassName` so we can widen past the default `max-w-lg` for comfortable editing (e.g. `max-w-3xl w-[90vw] h-[80vh]`).
- `components/vault/editor/doc-editor.tsx` — `DocEditor` (the `@uiw/react-md-editor` wrapper with the ghosting fix + edit/preview toggle). See §6.
- `getRuntimeTrpcClient(workspaceId).workspace.*` — existing CRUD (see §4).

### 3.3 Mount point & the "don't re-render the board" rule

`<VaultFileDialogProvider>` is mounted **high in `App.tsx`**, wrapping the main content region, and renders `{children}` plus one `<VaultFileDialog>`:

```tsx
<VaultFileDialogProvider>
  {/* existing main content incl. KanbanBoard */}
</VaultFileDialogProvider>
```

Open/close state (`{ open, fileId, workspaceId }`) lives **inside the provider's own component**, not in `App`. The provider's context value is the **stable `openVaultFile` function** (memoized) — consumers that read only the opener never re-render when the dialog opens. Critically, `children` is passed as a prop: when the provider re-renders on open, React keeps the same `children` element reference and bails out of re-rendering the board subtree. This mirrors the project's established perf rule (memory `perf10-runtime-store-selectors`): *high-frequency state stays in the leaf fiber that shows it.* Here the "leaf" is the dialog itself; the board is a sibling-by-reference, untouched.

## 4. Data flow — reuse existing tRPC (no new endpoints)

The `workspace` router already exposes full per-file CRUD (`src/trpc/app-router.ts`):

| Procedure | Input | Output | Dialog use |
|---|---|---|---|
| `workspace.getDocument` | `{ id }` | `{ document: RuntimeVaultDocument \| null }` | initial read |
| `workspace.updateDocument` | `{ id, title?, body?, frontmatter? }` (**patch** — omitted fields unchanged) | `{ document }` | save |

`RuntimeVaultDocument` (`src/core/api-contract.ts ~791`):
```
{ id, type, title, body /* markdown, frontmatter excluded */, frontmatter,
  relativePath, createdAt, updatedAt }
```

Key facts that shape the design:
- **Identifier is `id`** (a uuid; surfaced in frontmatter as `_id`). Stable across branch switches; `relativePath` is not. The dialog opens by `id`.
- `updateDocument` is **patch semantics**: sending `{ id, body }` (and/or `title`) leaves `frontmatter` and everything else intact. This is what lets v1 edit body/title **without touching frontmatter** — no corruption risk, and the properties panel can be added later orthogonally.

`use-vault-file-doc.ts` (new, thin) calls the tRPC client directly for a **single** doc:
```ts
// read:  getRuntimeTrpcClient(workspaceId).workspace.getDocument.query({ id })
// save:  getRuntimeTrpcClient(workspaceId).workspace.updateDocument.mutate({ id, title, body })
```

> **Do not reuse `useVaultDocs(workspaceId, type)`** for the dialog. That hook lists **all** docs of a type (`listDocuments`) — heavy, and it would re-import the browsing concern the dialog is meant to avoid. The dialog needs exactly one `getDocument` read + one `updateDocument` write.

## 5. State management — open / file / edit / save

Provider state (single `useState`/reducer):
```
{ open: boolean, fileId: string | null, workspaceId: string }
```

Dialog-local state (lives in `<VaultFileDialog>`, so it's created on open and discarded on close):
```
{ loadState: 'loading'|'ready'|'error',
  doc: RuntimeVaultDocument | null,
  draftTitle: string, draftBody: string,
  dirty: boolean, saveState: 'idle'|'saving'|'error' }
```

Lifecycle:
1. `openVaultFile(id, { workspaceId? })` → provider sets `{ open:true, fileId:id, workspaceId: id?? currentProjectId }`. `workspaceId` defaults to the current project (from the runtime store) so most call sites pass only the id.
2. Dialog mounts (Radix portal). On mount / `fileId` change → `getDocument.query({id})` → seed `draftTitle`/`draftBody` from the result (local-buffer pattern, same as `VaultDocDetail`).
3. Edits update the drafts + `dirty`. **Save** (explicit button in `DialogFooter`, plus commit-on-blur as in `VaultDocDetail`) → `updateDocument.mutate` → on success update local `doc`, clear `dirty`. `saveState` drives a spinner + disabled button.
4. **Close** (Esc / overlay / ✕ / Close button): if `dirty`, confirm via `AlertDialog` before discarding; otherwise `open=false`. Radix unmounts the portal → editor + drafts are released.

Because all editable surface is title + body and the save is a patch, there is no merge/frontmatter logic in v1.

## 6. Editor — reuse `DocEditor` (ghosting already handled)

The dialog body renders the **existing** `DocEditor` (`components/vault/editor/doc-editor.tsx`):
```tsx
<DocEditor value={draftBody} onChange={setDraftBody} onBlur={commitBody} />
```
`DocEditor` wraps `@uiw/react-md-editor`'s `MDEditor` and owns its own edit/preview toggle; preview delegates to `DocPreview` → `KanbanMarkdownContent`.

**Ghosting pitfall (already solved upstream — must stay solved):** react-md-editor stacks a transparent `<textarea>` (caret/selection) over a syntax-highlighted `<pre><code>` (visible text). If the textarea text is painted, or font metrics diverge between the two layers, you get a double-image. The fix lives in `web-ui/src/styles/globals.css ~1321–1347` scoped to `.kb-md-editor`: identical `font-size`/`line-height` on both layers, and the textarea's `-webkit-text-fill-color: transparent` is preserved (never color the textarea). **By reusing `DocEditor` unchanged, the dialog inherits this fix.** Do **not** re-instantiate `MDEditor` directly in the dialog or the ghosting regresses (memory `md-editor-ghosting-fix`).

`wikilinks` is an optional prop on `DocEditor`; v1 omits it (no in-dialog resolution — §9).

## 7. How this avoids the vault/database perf pitfall (contrast)

| | Full-page `VaultView` / `DatabaseView` (today) | Quick dialog (this design) |
|---|---|---|
| Board on open | **Unmounted** (conditional render swaps it out) | **Stays mounted**, untouched in the tree |
| Board on close | **Full remount** — columns/cards rebuilt, `content-visibility` cards re-paint | Nothing — board was never touched |
| New UI mounted | Entire vault browser (list + table/board + detail + data hooks listing all docs of a type) | One `<Dialog>` + one `DocEditor` + one `getDocument` read |
| Mount/unmount of the heavy UI | On every tab switch | Only the dialog, on open/close |
| Render isolation | View switch re-renders the App content region | Opener is a stable fn; `children` element reference unchanged → board subtree bails out of re-render |
| Network on open | `listDocuments` (all docs of a type) | `getDocument` (one doc) |

The dialog is *additive and ephemeral*: it layers over the board via a portal and disappears cleanly. None of the board-unmount/remount or `content-visibility` re-paint costs apply, because the board is never removed from the tree or resized.

> Note: this design does **not** fix the existing `VaultView`/`DatabaseView` board-unmount cost — those remain full-page tabs. It provides a lightweight *alternative path* for the single-file case. Migrating the full-page views to mount-but-hide is separate, out-of-scope work.

## 8. Trigger wiring & extension points

### 8.1 Current wikilink mechanics
- `[[target]]` in markdown is rendered by the shared `KanbanMarkdownContent` (`components/detail-panels/kanban-markdown-content.tsx ~188–215`); when a wikilink binding is supplied, its `<a>` override renders a `WikilinkChip`.
- `WikilinkChip` (`components/vault/links/wikilink-chip.tsx ~26–73`) renders a resolved link as a `<button onClick={() => onOpen?.(resolution)}>` where `resolution: { id, type, title }` (`wikilink-resolution.ts`).
- Today `onOpen` is only wired in `VaultView` (`vault-view.tsx ~165–178`) → `handleOpenDoc(type, id)` → in-place navigation **within the vault surface**. Wikilinks do nothing outside the vault.

### 8.2 The seam: `useOpenVaultFile()`
The dialog opener is the single extension point. Any surface that renders `KanbanMarkdownContent` can route wikilink clicks to it:
```ts
const openVaultFile = useOpenVaultFile();
// in the wikilink binding:
onOpen: (resolution) => openVaultFile(resolution.id),
```
The opener only needs an **`id`**. Turning `[[title]] → id` (the `resolve` step) is the caller's concern; the vault surface already has a resolver.

### 8.3 Recommended v1 wiring
Wire the dialog as the wikilink `onOpen` for **non-vault** surfaces — where "peek/edit a referenced file without leaving the board or chat" is the whole point and there is no existing browsing context to navigate within:
- `CardDetailView` markdown (task descriptions referencing files).
- Home-chat markdown.

`VaultView` keeps its in-place navigation (it *is* a browsing context; a dialog there would be redundant). This split means v1 adds the dialog where it pays off and changes no existing vault behavior.

> Dependency to flag: rendering wikilinks as clickable **outside** the vault requires a `resolve` (doc-index) binding on those surfaces, which they don't have today. The minimal v1 can ship the provider + dialog + opener and wire one concrete call site; broad wikilink-everywhere enablement (a shared cached resolver backed by `listDocuments`) is the follow-up. Decide per §10.

### 8.4 Future extension points
- **Board card → "open referenced file"**: a card affordance calls `openVaultFile(id)` directly (no resolver needed when the id is known). This is the reserved board-card trigger from the task brief.
- **Database view cell** referencing a vault doc → same opener.
- **In-dialog wikilink navigation** (§9).

## 9. Documented extensions (not v1)
- **Frontmatter editing**: render the existing `VaultPropertiesPanel` (used by `VaultDocDetail`) in a collapsible section; saves go through the same `updateDocument` patch with `frontmatter`.
- **In-dialog wikilink navigation**: pass a `wikilinks` binding to `DocEditor` whose `onOpen` calls `openVaultFile(res.id)` again (the provider re-points `fileId`, with the dirty-guard from §5). Optionally a small back-stack. Needs a resolver (see §8.3).
- **Create-from-dialog**: `workspace.createDocument` already exists; an "open or create" opener variant could create then open.

## 10. Open questions / decisions to confirm before building
1. **Save model**: explicit Save button **plus** commit-on-blur (matches `VaultDocDetail`), or Save-button-only? Recommendation: both, with a dirty-guard on close. (Leaning Save+blur for least surprise.)
2. **v1 trigger reach**: wire only `CardDetailView` + home-chat wikilinks (needs adding a resolver binding there), or ship the seam and wire a single concrete call site first? Recommendation: ship provider+dialog+opener, wire `CardDetailView` first; expand once a shared resolver exists.
3. **Dialog size**: confirm `max-w-3xl w-[90vw] h-[80vh]` (via `contentClassName`) vs. a wider/near-fullscreen sheet.

## 11. Affected files (summary)
New (web-ui):
- `components/vault/quick-dialog/vault-file-dialog-provider.tsx`
- `components/vault/quick-dialog/vault-file-dialog.tsx`
- `components/vault/quick-dialog/use-vault-file-dialog.ts`
- `components/vault/quick-dialog/use-vault-file-doc.ts`

Touched (web-ui):
- `App.tsx` — mount `<VaultFileDialogProvider>` around the main content region.
- One trigger call site (recommended: `CardDetailView` wikilink binding) — route `onOpen → openVaultFile(id)`.

Reused unchanged:
- `components/ui/dialog.tsx`, `components/vault/editor/doc-editor.tsx`, `styles/globals.css` (`.kb-md-editor`), `workspace.getDocument` / `workspace.updateDocument` tRPC.

Backend: **none** (no new tRPC, no new read/write paths).
