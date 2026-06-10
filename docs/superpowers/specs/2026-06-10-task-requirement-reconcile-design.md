# Task→Requirement Reconciliation — Design Spec

Date: 2026-06-10

## Goal

Add a **Task→Requirement Reconciliation** capability — analogous to the existing
**Requirement Review** (analyze → apply, two phases), but the axis under review
is **task ↔ requirement linkage** instead of requirement quality.

The kanban agent does the semantic matching freely; **every AI product lands in a
pending-confirmation state** (`proposed` link and/or `draft` requirement) and is
confirmed product-side by a human. Nothing the agent produces is ever written as
`confirmed` directly.

### Why this fits the existing code

The Requirement Review spec (`docs/superpowers/specs/2026-06-09-requirement-review-design.md`)
explicitly **skipped gates 4 (orphan) and 5 (misassignment)** because
task↔requirement linkage did not exist in the data model
(`src/core/requirement-review.ts:20-21`). That linkage now exists:

- `src/core/requirement-task-link-mutations.ts` — `proposeLink` / `confirmLink` /
  `rejectLink` / `unlink`, with link `status: "proposed" | "confirmed"` and a
  `source: "human" | "agent"` field, each mutation appending a version.
- `src/core/api-contract.ts` — `runtimeRequirementTaskLinkSchema`,
  `runtimeRequirementTaskLinksDataSchema`, and `requirementTaskLinks` carried in
  the workspace state response and the mutation context.

This feature is therefore the **orphan axis** (gate 4) that Review deferred,
delivered as its own command pair rather than folded back into `review` — which
keeps the two concerns (requirement quality vs. task linkage) separated, matching
how the existing code already treats them.

## Architecture — two phases, agent is the reasoner

The CLI provides mechanics only; it embeds **no LLM call**. Two subcommands are
added under the existing `requirement` command group, mirroring `review` /
`review apply`.

### Phase 1 — `kanban requirement reconcile` (analyze, read-only)

Loads workspace state (`board`, `requirements`, `requirementTaskLinks`) and emits
a structured **reconcile packet** (JSON) for the agent to reason over. The CLI
does the deterministic orphan-detection; the **semantic** judgment (which
requirement a task matches, or whether a new draft is warranted) is the agent's
job.

**Orphan definition (confirmed product-side):** a task is a candidate only when it
has **no link at all** — neither `confirmed` nor `proposed`. Tasks that already
carry a `proposed` link are mid-reconciliation and are reported separately under
`pendingProposed` (visibility only, never candidates), so `apply` can never
double-propose.

Packet shape:

```jsonc
{
  "ok": true,
  "workspacePath": "/abs/path",
  "orphanTasks": [
    {
      "taskId": "card-1",
      "title": "Resolved card title",
      "prompt": "full card prompt text",
      "columnId": "todo",
      "columnTitle": "To Do"
    }
  ],
  "requirementCatalog": [
    { "id": "req-1", "title": "...", "description": "...", "status": "active", "priority": "high" }
  ],
  "pendingProposed": [
    { "taskId": "card-2", "requirementId": "req-1" }
  ],
  "orphanCount": 1,
  "requirementCount": 1
}
```

### Phase 2 — `kanban requirement reconcile apply` (mutate, source=agent)

Reads an agent-decided **reconcile plan** (JSON, via `--plan <file>` or stdin),
validates it with a zod schema, and applies it inside
`updateRuntimeWorkspaceState`, writing back `requirements`, `requirementTaskLinks`,
and `requirementVersions`.

Plan shape — a strict discriminated union on `action`:

```jsonc
{
  "entries": [
    {
      "action": "link",
      "taskId": "card-1",
      "requirementId": "req-1",
      "reason": "Card implements the auth flow described by req-1."
    },
    {
      "action": "create-draft",
      "taskId": "card-3",
      "requirement": { "title": "Offline sync", "description": "...", "priority": "high" },
      "reason": "No existing requirement covers offline sync."
    }
  ]
}
```

- **`link`** → `proposeLink(requirements, links, versions, requirementId, taskId,
  { source: "agent", reason })`. Produces a `proposed` link; a version is appended
  by the existing mutation.
- **`create-draft`** → `addRequirement(...)` with **`status` forced to `"draft"`**
  (status is **not** part of the schema — the proposed/draft invariant is enforced
  structurally, not by trusting the agent), version recorded with
  `source: "agent"` / `changeKind: "create"`, then `proposeLink(...)` for the new
  requirement (`source: "agent"`).

`create-draft.requirement` accepts `title` (required, min 1), `description`
(optional), and `priority` (optional, defaults to schema default `medium`).
`status` is intentionally absent.

Result / report:

```jsonc
{
  "ok": true,
  "workspacePath": "/abs/path",
  "entries": [
    { "action": "link", "taskId": "card-1", "requirementId": "req-1", "why": "..." },
    { "action": "create-draft", "taskId": "card-3", "requirementId": "<new-uuid>", "why": "..." }
  ],
  "summary": { "link": 1, "createDraft": 1, "versionsWritten": 3 }
}
```

## New pure module — `src/core/requirement-reconcile.ts`

Mirrors `requirement-review.ts`: pure, side-effect-free, fully unit-testable, no
`any`. Reuses the upstream link data layer and version history rather than
re-implementing either.

```ts
// Analyze
export interface AnalyzeReconcileOptions { now?: number; }
export interface ReconcileOrphanTask { taskId; title; prompt; columnId; columnTitle; }
export interface ReconcileRequirementSummary { id; title; description; status; priority; }
export interface ReconcilePendingLink { taskId; requirementId; }
export interface ReconcilePacket {
  orphanTasks: ReconcileOrphanTask[];
  requirementCatalog: ReconcileRequirementSummary[];
  pendingProposed: ReconcilePendingLink[];
}
export function analyzeReconcile(
  board: RuntimeBoardData,
  requirements: RuntimeRequirementsData,
  links: RuntimeRequirementTaskLinksData,
  options?: AnalyzeReconcileOptions,
): ReconcilePacket;

// Apply
export const reconcilePlanSchema: z.ZodType<ReconcilePlan>;       // strict union on `action`
export type ReconcilePlan = z.infer<typeof reconcilePlanSchema>;
export interface ApplyReconcilePlanDeps { randomUuid: () => string; now?: number; }
export interface ReconcileReport { entries: ReconcileEntryReport[]; summary: ReconcileSummary; }
export interface ApplyReconcileResult {
  requirements: RuntimeRequirementsData;
  links: RuntimeRequirementTaskLinksData;
  versions: RuntimeRequirementVersionsData;
  report: ReconcileReport;
}
export function applyReconcilePlan(
  requirements: RuntimeRequirementsData,
  links: RuntimeRequirementTaskLinksData,
  versions: RuntimeRequirementVersionsData,
  plan: ReconcilePlan,
  deps: ApplyReconcilePlanDeps,
): ApplyReconcileResult;
```

Notes on the analyze pass:
- A task's "has a link" test scans `links.links` for any entry whose `taskId`
  matches, regardless of `status`. Orphans = board cards across all columns whose
  id appears in no link. `pendingProposed` = links with `status: "proposed"`.
- Board cards are read across every column in `board.columns`; the card `title`
  is already resolved by `runtimeBoardCardSchema`'s transform.

Notes on the apply pass:
- Thread `requirements` / `links` / `versions` through each entry sequentially
  (each mutation returns the next snapshot of all three), matching how
  `applyReviewPlan` threads `data` / `versionData`.
- `create-draft` increments `versionsWritten` by 2 (the `create` version from
  `addRequirement` + the `update` version `proposeLink` appends); `link`
  increments it by 1. This mirrors the existing `proposeLink` behavior, which
  always records a version even though a `proposed` link is not mirrored into
  `linkedTaskIds`. Consistency with the upstream layer is preferred over
  suppressing that version.
- A plan entry referencing a non-existent `requirementId` (link) or a duplicate
  link surfaces as an error thrown by the reused mutation, consistent with
  `applyReviewPlan`'s throw-on-conflict behavior.

## CLI wiring — `src/commands/requirement.ts`

Two new handlers + registration, modeled on `reviewRequirements` /
`applyRequirementReviewCommand`:

- `reconcileRequirements({ cwd, projectPath })` — resolve workspace, `getState`,
  call `analyzeReconcile(state.board, state.requirements, state.requirementTaskLinks)`,
  print packet.
- `applyRequirementReconcileCommand({ cwd, planPath, projectPath })` — read plan
  (reuse `readReviewPlanInput`), `JSON.parse`, `reconcilePlanSchema.safeParse`,
  then `updateRuntimeWorkspaceState` calling `applyReconcilePlan(...)` and writing
  back `requirements`, `requirementTaskLinks`, `requirementVersions`.

Registration:

```
requirement reconcile                 # analyze, read-only
requirement reconcile apply --plan ?  # mutate; --plan optional, else stdin
```

Both take `--project-path`. The `apply` action uses a regular `function` and
`this.optsWithGlobals()` to read `--plan` / `--project-path` — per the commander
nested-subcommand gotcha documented in AGENTS.md (a child re-declaring a parent
option otherwise routes the value to the parent).

## Testing

- `test/runtime/requirement-reconcile.test.ts` (unit, vitest) — mirrors
  `requirement-review.test.ts`:
  - `analyzeReconcile`: orphan detection across columns; a task with a
    `confirmed` link is excluded; a task with a `proposed` link is excluded from
    orphans and appears under `pendingProposed`; empty board / empty requirements.
  - `reconcilePlanSchema`: accepts valid `link` and `create-draft` entries;
    rejects unknown `action`, missing `taskId`/`requirementId`, a `status` field
    inside `create-draft.requirement`, and empty `entries`.
  - `applyReconcilePlan`: `link` produces a `proposed` link with `source:"agent"`
    + one version; `create-draft` creates a `draft` requirement, proposes a link,
    and writes two versions; summary counts; sequential threading across multiple
    entries; throw on duplicate/unknown link.

## Out of scope

- Gate 5 (misassignment / reassigning a task from the wrong requirement) — a
  separate axis; not part of this orphan-reconciliation pass.
- Any web-ui surface for reconcile — this spec covers the core + CLI only.
- Auto-confirming links — confirmation stays a human, product-side action via the
  existing `confirmLink`.
