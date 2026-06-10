# Requirement Proposal Review Panel — Design

Date: 2026-06-10
Status: Approved (pending implementation plan)

## Problem

The "task→requirement coordination" capability produces two kinds of output that
need product-side confirmation before they become real backlog state:

1. **Proposed links** — agent (or human) suggestions associating a task with a
   requirement (`RuntimeRequirementTaskLink` with `status: "proposed"`).
2. **Draft requirements** — requirement items the coordination round suggests
   creating (`RuntimeRequirementItem` with `status: "draft"`).

Today there is no product-facing surface to review these in a batch. The Board UI
main flow must stay untouched; this is a review entry on the **requirements side**.

## Goals

- A PR-style batch review surface: collect a round of coordination output and let
  the product owner **accept / reject / re-attach** each item.
- Accept a proposed link → `confirmed` (mirrored into the requirement's
  `linkedTaskIds`). Reject → remove the proposed link.
- Accept a draft requirement → `active`. Reject → delete it.
- Re-attach a proposed link onto a different requirement.
- Reuse the existing version-history diff renderer and the existing `draft` status
  styling. Scattered / uncertain proposals fall into a "待确认" (pending) inbox as a
  fallback.
- Read all data from the existing workspace sync stream (`useWorkspaceSync`) — no
  new channel.

## Non-Goals (YAGNI)

- No integration with the requirement **version store** (`requirementVersions` is
  CLI-only and not in the sync stream).
- No board-side changes (task cards gain no new fields).
- No new routes or API endpoints.
- No "accept all" batch action in v1 — per-item actions only.

## Key Decisions

1. **Draft scope = all draft-status requirements.** Requirement items carry no
   provenance/source field, so the panel cannot distinguish an agent-proposed draft
   from a human WIP draft. We treat `status: "draft"` itself as the pending bucket:
   review → promote to `active` or discard. This reuses the existing draft status
   exactly and adds zero data model.
2. **Placement = a "Review" tab inside `RequirementsView`.** A segmented
   `List | Review` toggle in the Requirements header, with a count badge of pending
   proposals. Stays entirely on the requirements side; Board untouched.

## Existing Building Blocks (verified)

- `runtimeWorkspaceStateResponseSchema` (src/core/api-contract.ts) **already
  includes** `requirementTaskLinks` (`{ links: RuntimeRequirementTaskLink[] }`),
  and `runtimeWorkspaceStateSaveRequestSchema` accepts it back optionally. The link
  schema has first-class `status: "proposed" | "confirmed"` and
  `source: "human" | "agent"`.
- `ReadOnlyUnifiedDiff` + `buildUnifiedDiffRows` in
  `web-ui/src/components/shared/diff-renderer.tsx` — reusable to preview proposed
  content (all-added diff).
- `StatusBadge` / draft styling in `web-ui/src/components/requirements/requirement-meta.tsx`.
- Pure state helpers in `web-ui/src/state/requirements-state.ts`
  (`updateRequirement`, `deleteRequirement`).

## Architecture & Data Flow

All reads/writes ride the existing pipeline:

```
runtime ──stream──► useWorkspaceSync ──► App state ──► RequirementsView ──► ReviewPanel
   ▲                  setRequirements        requirements          (List | Review tabs)
   │                  setRequirementTaskLinks requirementTaskLinks
   └──save(existing)─ useWorkspacePersistence ◄── onRequirementsChange / onLinksChange
```

`requirementTaskLinks` already travels the stream and save request but is not yet
wired on the web-ui side. Three small wiring changes carry it along the same path
that already carries `requirements`:

- **`web-ui/src/App.tsx`** — add `requirementTaskLinks` state parallel to
  `requirements`; pass `setRequirementTaskLinks` to `useWorkspaceSync`, the
  value+setter to `useWorkspacePersistence`, and `links` + `board` (tasks) + change
  handlers to `RequirementsView`.
- **`web-ui/src/hooks/use-workspace-sync.ts`** — read
  `nextWorkspaceState.requirementTaskLinks ?? { links: [] }` alongside requirements,
  and reset to `{ links: [] }` on project switch / no-projects (mirroring the
  existing `setRequirements({ items: [] })` calls).
- **`web-ui/src/runtime/use-workspace-persistence.ts`** — add
  `requirementTaskLinks` to the params, the save `payload`, the
  `lastPersistedRequirementTaskLinksRef`, and the change-detection guard (currently
  board+requirements).

## Components

New, under `web-ui/src/components/requirements/review/`:

- **`requirement-review-panel.tsx`** — the PR-style batch view. Renders three
  collapsible grouped sections, each with a count:
  1. **Proposed links** (`status === "proposed"`) — source badge (agent/human),
     task card title, target requirement title.
  2. **Draft requirements** (`status === "draft"`) — title + description preview via
     `ReadOnlyUnifiedDiff` (`buildUnifiedDiffRows(null, description)`), reusing
     `StatusBadge`.
  3. **待确认 Inbox** — fallback bucket for proposals that cannot be cleanly
     batch-acted: a proposed link whose target requirement is itself still a draft
     (confirming it would link into something unconfirmed), or a proposed link whose
     task or requirement no longer resolves (dangling). Softer "needs attention"
     treatment, not one-click accept/reject.
- **`requirement-proposal-row.tsx`** — one row: summary + per-item actions.
  Link rows: **Accept / Reject / Re-attach**. Draft rows: **Accept / Reject**.
- **`reattach-requirement-popover.tsx`** — Radix popover with a searchable list of
  non-draft requirements; selecting one moves the proposed link's `requirementId`.

## State Helper

New, pure + tested: **`web-ui/src/state/requirement-task-links-state.ts`**, following
the `requirements-state.ts` conventions (pure functions returning new data),
replicating core's mirror semantics:

- `confirmLink(linksData, requirements, requirementId, taskId)` → set the link's
  `status: "confirmed"` **and** add `taskId` to that requirement's `linkedTaskIds`.
  Returns `{ links, requirements }`.
- `rejectLink(...)` → remove the proposed link (and ensure it is not left in
  `linkedTaskIds`).
- `reattachLink(..., newRequirementId)` → move a proposed link to another
  requirement.
- `selectPendingProposals(links, requirements, board)` → derive the three buckets
  above. All grouping / inbox logic lives here and is fully unit-testable.

Accept-draft / reject-draft reuse the existing
`updateRequirement(id, { status: "active" })` / `deleteRequirement(id)` — no new code.

## Header Integration

In `web-ui/src/components/requirements/requirements-view.tsx`, add a segmented
**List | Review** toggle next to the existing filters. The Review tab shows a count
badge of total pending proposals (`proposed` links + `draft` requirements). The
existing list flow and Board UI are untouched.

## Error Handling

- Persistence conflicts are already handled by the existing optimistic-revision
  path: if the agent writes proposed links via the CLI while the user acts, the save
  conflicts → `useWorkspacePersistence` refetches. No new handling needed.
- Empty states per section; the whole Review tab shows a clean "No proposals to
  review" when all buckets are empty.

## Testing

- Unit tests for `requirement-task-links-state.ts`:
  - `confirmLink` flips status and mirrors `taskId` into `linkedTaskIds`.
  - `rejectLink` removes the proposed link and leaves no residue in `linkedTaskIds`.
  - `reattachLink` moves the link to the new requirement.
  - `selectPendingProposals` bucketing, including dangling links and draft-target
    links routing to the inbox.
- Component-level rendering / empty-state coverage consistent with existing
  requirements component tests.
