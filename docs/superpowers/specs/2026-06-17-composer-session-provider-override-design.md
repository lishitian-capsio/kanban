# Composer provider switch → pure session-level override (home sidebar chat)

**Date:** 2026-06-17
**Status:** Approved (design)
**Task:** dca79 — depends on 12813 (consolidate provider management) + 6e0b4 (fold profile into provider)

## Problem

The home sidebar chat composer renders `AgentProfileControl` (only there — it is the
sole consumer of `KanbanChatComposer`'s `modelControlSlot`, gated by
`agentProfilesEnabled && profileAgentId` in `use-home-sidebar-agent-panel.tsx`). That
control:

- switches the agent's **config profile** (a concept 6e0b4 is removing), not a provider;
- carries full **create / edit / rename / delete / duplicate** capability (dialogs); and
- **persists** the selection through the 6c49b profile tRPC layer (it mutates workspace
  state, not a per-session choice).

We want the composer switch to mean exactly one thing: **"for this one session, use this
provider."** It must not change the agent's default provider, must not touch any other
running session, and must offer only a pick from the agent's already-defined named
providers (no freeform create/edit). This mirrors the home-multithread rule that
switching never tears down another thread's session.

## Decisions (approved)

1. **Replace the composer control as part of this task.** 6e0b4 is still `in_progress`
   and has not yet removed `AgentProfileControl` from the composer / left a provider
   hookpoint. Per user decision, dca79 removes `AgentProfileControl` from the composer
   and installs the provider switch itself. dca79 does **not** do 6e0b4's backend
   profile-data-layer teardown (store / registry / selection / profile tRPC / migration)
   or the deletion of `web-ui/src/components/agent-profiles/**` — those stay until 6e0b4
   lands. Only the composer stops referencing the profile control.
2. **Provider selector only.** No inline model/reasoning picker. The session uses the
   chosen provider's configured default model (resolved server-side).
3. **Override applies at next launch only; never restarts a running session.** pi fixes
   its provider at process launch and cannot hot-swap; pi "resume" is view-only (a restart
   drops live LLM context). So switching writes the thread's override and it takes effect
   when that thread's session next (re)starts. The primary flow — pick a provider on an
   idle thread, then send the first message — is covered exactly. A mid-session switch has
   no effect on the live process (documented, not surprising).
4. **Pick-only, from the agent's named provider set.** Source is the existing
   `listAgentProviders` (`RuntimeAgentProviderSetListResponse`, secrets already redacted),
   which carries `providers[]` + `defaultProviderId`.
5. **Override is per-thread, in-memory (not persisted).** Keyed by the home thread's
   synthetic task id. Persisting per-thread provider to `threads.json` is a possible
   future enhancement but YAGNI now: the running session is server-side and survives a
   browser reload untouched; the override only matters at launch.

## Mental model

```
Settings → Agent (single source of truth)        Composer switch (this task)
──────────────────────────────────────────       ──────────────────────────────────
defines providers[] + defaultProviderId           SELECTS one of providers[] for the
(create / edit / delete / set-default)             current thread's session only
                                                   (no create/edit; no default change;
                                                    no effect on other sessions)
```

## Backend

### The session-level override channel for the home chat

The board detail view already passes a per-session provider override
(`startTaskSession` → `body.agentSettings.providerId` →
`resolvePiLaunchConfig({ providerIdOverride })`). The **home sidebar chat does not**: it
lazily starts its pi session inside `sendTaskChatMessage` (runtime-api.ts ~line 893/900),
resolving the provider server-side from the selected profile
(`loadSelectedPiLaunchProfile`). There is no override input on that path today.

Add the channel:

- Extend `runtimeTaskChatSendRequestSchema` (`api-contract.ts`) with an optional
  `providerId: z.string().optional()` (a select, not freeform — it is the name of a
  provider already in the agent's set).
- In `sendTaskChatMessage`'s home lazy-start branch, pass
  `providerIdOverride: body.providerId ?? undefined` into `resolvePiLaunchConfig`. The
  existing `workspaceProfile` argument stays (it remains the lower-priority fallback until
  6e0b4 removes the profile layer; the override already outranks it).
- Frontend plumbing: `useKanbanChatRuntimeActions.sendTaskChatMessage` and
  `SendKanbanChatMessageOptions` gain an optional `providerId`; the home panel injects the
  active thread's override into the send call.

`reloadTaskSession` (reattach-after-restart) is intentionally left on the
profile/store-default path for v1 — the override is not persisted, and a reattach of an
already-launched session must not be re-pinned to a different provider. Documented edge.

### Correctness fix — store layer must resolve by the overridden provider

`resolvePiLaunchConfig` resolves `modelId`/`baseUrl` from the machine-home store via
`resolveStoreLayer()`, which calls `getAgentProviderConfig("pi")` — **always the agent's
default provider**, ignoring any overridden `providerId`. So overriding to a *non-default*
provider while sending only `providerId` would pair it with the **default** provider's
model and base URL. (This latent gap is shared by the board path, which works around it
only because it also sends `modelId`.)

Because this task deliberately sends **provider only**, fix the resolver so the store
layer is provider-aware:

```ts
// resolveStoreLayer takes the already-resolved providerId
const store = resolveStoreLayer(providerId); // providerId from override/profile so far
//   → getAgentProviderConfig("pi", providerId ?? undefined)
//   → that provider's model + baseUrl (or the default provider's when providerId is null)
```

With this, sending just `providerId` is fully correct: model, base URL, API key
(`resolvePiApiKey(providerId)` already keys by providerId) all come from the chosen
provider's stored config. No `modelId` needs to cross the wire.

**Coordination note:** `resolvePiLaunchConfig` is also being refactored by 6e0b4
(remove the profile layer) and polished by c95ff (priority-chain stepping + unit tests),
all on the shared `consolidate-provider-management` branch. This change is small and
additive (one new parameter on `resolveStoreLayer`, one call-site argument); the unit test
below documents the required behavior so a later refactor preserves it.

## Frontend

### New component — `SessionProviderControl` (pick-only)

`web-ui/src/components/agent-providers/session-provider-control.tsx` (new dir; replaces the
composer's use of `agent-profiles/agent-profile-control.tsx`).

Props: `{ workspaceId, agentId, selectedProviderId, onSelectProvider, disabled }`.

- Loads the agent's provider set via a small hook `useAgentProviderSet(workspaceId,
  agentId)` wrapping `fetchAgentProviderSets` (`listAgentProviders`). Exposes
  `providers[]` (each `{ provider, model }`) + `defaultProviderId`.
- Renders a compact selector (reusing `SearchSelectDropdown` like the model selector) of
  provider names. The selected value defaults to `defaultProviderId` when the thread has
  no override. **No** new/edit/rename/delete/duplicate actions, **no** model/reasoning
  picker. An optional tooltip points to Settings → Agent to manage providers.
- `onSelectProvider(providerId)` reports the pick up to the owner.

### Override state ownership — `use-home-sidebar-agent-panel.tsx`

The home panel owns the per-thread override and builds the slot, decoupling the chat panel
from provider concepts:

- New state `providerOverrideByTaskId: Record<string, string>` (in-memory).
- Builds `modelControlSlot = <SessionProviderControl … selectedProviderId={override[taskId]
  ?? defaultProviderId} onSelectProvider={(pid) => setOverride(taskId, pid)} />` and passes
  it to `KanbanAgentChatPanel` via the existing `modelControlSlot` prop.
- `handleSendHomeKanbanChatMessage` injects `providerId: override[taskId]` (falling back to
  the set's `defaultProviderId`) into `sendTaskChatMessage`.

### `KanbanAgentChatPanel` becomes provider-agnostic

- Remove the `agentProfilesEnabled` / `profileAgentId` props and the internal
  `AgentProfileControl` construction. The panel now only renders whatever
  `modelControlSlot` it is handed (board detail view passes none → default model selector;
  home panel passes the provider control). This is the clean separation the composer
  comment already anticipates.

## Data flow

```
Settings → Agent ──defines──▶ listAgentProviders ──▶ useAgentProviderSet
                                                          │
home thread (idle) ─ user picks provider ─▶ setOverride(taskId, providerId)  [in-memory]
                                                          │
first send ─▶ sendTaskChatMessage({ …, providerId }) ─▶ runtime-api lazy-start
                                                          │
                       resolvePiLaunchConfig({ providerIdOverride })
                       + provider-aware store layer ─▶ model/baseUrl/apiKey of that provider
                                                          │
                                       pi session launches with the chosen provider
```

Other threads' sessions are never referenced; the agent default
(`defaultProviderId`) is never written.

## Testing

- **Unit (backend):** `resolvePiLaunchConfig` — overriding `providerIdOverride` to a
  non-default provider resolves **that** provider's `modelId` and `baseUrl` (not the
  default's); with no override it still resolves the default provider (regression).
- **Unit (frontend):** `SessionProviderControl` lists the set's providers, defaults to
  `defaultProviderId`, fires `onSelectProvider` on pick, and exposes no create/edit
  affordance. `useAgentProviderSet` selects the right agent's set.
- **Behavioral:** home panel send injects the active thread's override `providerId`;
  switching the override for thread A does not change thread B's send payload or the agent
  default.
- Gate: `web:typecheck` + `biome` clean (per project convention; backend `tsc`/vitest have
  known pre-existing failures — diff against baseline).

## Non-goals

- 6e0b4's backend profile teardown and `agent-profiles/**` deletion.
- Persisting the per-thread provider across reloads (`threads.json`).
- Restarting a running session on switch; mid-session hot-swap.
- Any change to the board detail view's existing per-task provider/model override.
- Per-session model or reasoning override from the composer.
