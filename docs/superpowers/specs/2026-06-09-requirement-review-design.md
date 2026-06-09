# Requirement Review — Design Spec

Date: 2026-06-09

## Goal

Add a "Requirement Review" capability — analogous to code review, but for the
workspace's requirement items. A kanban agent performs one pass over the
existing requirements and **directly revises them**. There is no per-change
human approval gate; the safety net is the existing requirement **version
history** (every change is versioned, diffable, and revertible).

Depends on the completed "requirement version history (data layer + CLI)" task.
Every mutation goes through the existing requirement `add` / `update` / `delete`
interfaces and appends a version with `source: "agent"`.

## Review gates

1. **Duplicate** — two requirements are really the same thing → **merge**.
2. **Too broad** — one requirement mixes several unrelated intents → **split**.
3. **Unqualified** — vague description / no acceptance criteria / missing
   priority → **fill in / qualify**.
4. **Orphan or should-finish** — requirement has no tasks, or all its tasks are
   done but it is still `active` → **adjust status**.
5. **Misassignment** — a task is attached to the wrong requirement → **reassign**.
6. **Stale** — an `active` requirement untouched for a long time → flag or archive.

### Linkage-dependent gates (4 & 5) are skipped

Gates 4 and 5 both require knowing which tasks belong to a requirement. That
linkage **does not exist** in the data model today:

- Board cards (`runtimeBoardCardSchema`) have no `requirementId` field.
- `RuntimeRequirementItem.linkedTaskIds` is always written as `[]` (its schema
  comment marks it "Reserved for the future link/split capability").

Per the task instruction for gate 5 ("if the association is not yet implemented,
skip the dimension and explain"), **both gates 4 and 5 are skipped**. The
analyze output lists them under `skippedGates` with the reason, so the agent and
any reader know they were intentionally not evaluated. When task↔requirement
linkage lands, these gates can be implemented without changing the command
surface.

## Architecture — two phases, agent is the reasoner

The kanban agent (the Claude session running the task) is the brain. The CLI
provides mechanics only; it does **not** embed an LLM call. Two subcommands are
added under the existing `requirement` command group.

### Phase 1 — `kanban requirement review` (analyze, read-only)

Loads workspace state and emits a structured **review packet** (JSON) for the
agent to reason over. It runs the *deterministic* checks and surfaces hints; the
*semantic* judgments (gates 1, 2, and the wording part of 3) are the agent's job.

Packet shape:

```jsonc
{
  "ok": true,
  "workspacePath": "/abs/path",
  "staleDays": 30,
  "requirements": [ /* formatted requirement records */ ],
  "signals": [
    {
      "id": "<requirementId>",
      "title": "...",
      "status": "active",
      "stale": true,                 // gate 6: active & updatedAt older than staleDays
      "staleForDays": 47,
      "vagueDescription": true,      // gate 3: empty or very short description
      "missingAcceptanceCriteria": true, // gate 3: no acceptance-criteria markers
      "priorityIsDefault": true      // gate 3 hint: still at default "medium"
    }
  ],
  "skippedGates": [
    { "gate": 4, "name": "orphan-or-finish", "reason": "task↔requirement linkage not implemented" },
    { "gate": 5, "name": "misassignment",   "reason": "task↔requirement linkage not implemented" }
  ],
  "gateGuide": [ /* short description of every gate so the agent knows what to look for */ ]
}
```

Deterministic signal definitions:

- `stale`: `status === "active"` and `now - updatedAt >= staleDays * 86_400_000`.
  Threshold default 30 days, overridable with `--stale-days <n>`.
- `vagueDescription`: trimmed description is empty or shorter than 24 chars.
- `missingAcceptanceCriteria`: description contains none of the acceptance-criteria
  markers (case-insensitive: "accept", "验收", "given/when/then", "- [ ]" checklist).
- `priorityIsDefault`: `priority === "medium"` (the schema default). Priority is
  never null, so this is a *hint*, not a hard finding — the agent decides.

### Phase 2 — `kanban requirement review apply --plan <file>` (execute)

Reads a JSON **action plan** (the agent's decisions), validates it with a zod
schema, and applies every action inside a **single**
`updateRuntimeWorkspaceState` transaction (one revision bump). Actions are
applied sequentially against the evolving in-memory state; each primitive write
appends a version with `source: "agent"` and the action's `reason`.

Action kinds:

```jsonc
{
  "actions": [
    { "kind": "update",  "id": "r1", "reason": "added acceptance criteria",
      "changes": { "title": "...", "description": "...", "priority": "high", "status": "active" } },

    { "kind": "archive", "id": "r2", "reason": "stale 60d, superseded" },
    // sugar for update with status: "archived"

    { "kind": "merge",   "survivorId": "r3", "duplicateIds": ["r4", "r5"],
      "reason": "r4/r5 duplicate r3",
      "changes": { "description": "merged description" } },
    // updates survivor (optional changes), then deletes each duplicate

    { "kind": "split",   "sourceId": "r6", "reason": "mixed two intents",
      "sourceChanges": { "title": "narrowed", "description": "..." },
      "newRequirements": [ { "title": "...", "description": "...", "priority": "medium" } ] },
    // updates source (optional), then creates each new requirement

    { "kind": "delete",  "id": "r7", "reason": "obsolete" }
  ]
}
```

Validation rules:
- `update.changes` must contain at least one field.
- `merge`: `survivorId` must not appear in `duplicateIds`; ids must be distinct
  and exist.
- `split.newRequirements` must be non-empty; each needs a non-empty title.
- Unknown / missing ids fail the whole plan (transaction is all-or-nothing).
- `reason` is required on every action and is recorded as the version `reason`.

Report shape (the deliverable):

```jsonc
{
  "ok": true,
  "workspacePath": "/abs/path",
  "actions": [
    { "kind": "update", "requirementId": "r1", "what": "updated description, priority",
      "why": "added acceptance criteria", "version": 4 },
    { "kind": "merge",  "survivorId": "r3", "what": "merged 2 duplicates into r3",
      "why": "r4/r5 duplicate r3",
      "survivorVersion": 3,
      "deleted": [ { "requirementId": "r4", "version": 2 }, { "requirementId": "r5", "version": 5 } ] },
    { "kind": "split",  "sourceId": "r6", "what": "split into 2 new requirements",
      "why": "mixed two intents", "sourceVersion": 2,
      "created": [ { "requirementId": "r8", "version": 1 }, { "requirementId": "r9", "version": 1 } ] }
  ],
  "summary": { "update": 1, "archive": 0, "merge": 1, "split": 1, "delete": 0, "versionsWritten": 7 }
}
```

Each entry ties a requirement to *what changed*, *why*, and the *resulting
version number*, satisfying the deliverable.

## Code structure

New, mostly pure code so it is fully testable without a model:

- `src/core/requirement-review.ts`
  - `analyzeRequirements(requirements, opts): ReviewPacketData` — pure;
    computes signals + skipped gates. (Board is accepted but unused for now,
    reserved for when gates 4/5 land.)
  - `applyReviewPlan(requirements, versions, plan, deps): ApplyReviewResult` —
    pure reducer composing `addRequirement` / `updateRequirement` /
    `deleteRequirement` + `appendRequirementVersion({ source: "agent" })`.
    Returns `{ data, versions, report }`.
  - Zod schemas + inferred types for the plan and report. These are CLI-level
    contracts, kept in this file (not `api-contract.ts`, which holds runtime API
    contracts).
- `src/commands/requirement.ts` — register `review` and `review apply`
  subcommands; analyze is read-only, apply runs inside
  `updateRuntimeWorkspaceState`.
- `test/runtime/requirement-review.test.ts` — analyze signal correctness; each
  apply action; `source: "agent"` on every written version; report version
  numbers; transaction atomicity on bad plans.

## Out of scope

- Task↔requirement linkage (gates 4 & 5).
- web-ui surface for review (CLI/agent only for now).
- Any embedded LLM call inside the CLI.

## TypeScript / repo conventions

- No `any`. All inputs validated by zod; types inferred from schemas.
- Top-level imports only.
- Pure core logic separated from CLI I/O, mirroring the existing
  `requirement-mutations.ts` / `requirement-versions.ts` split.
