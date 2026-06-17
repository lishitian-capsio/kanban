# Consolidate provider management into Settings → Agent

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

Provider definitions (the API endpoint, base URL, credentials, region/GCP config) can
currently be created and edited from **two** places:

1. **Settings → Providers** — `KanbanAddProviderDialog`, the intended freeform editor.
2. **The composer-adjacent agent-profile editor** (`agent-profile-edit-dialog.tsx`).

The second one is not obvious: a "profile" is supposed to be a non-secret launch bundle,
but its **Base URL / API key / region / GCP** fields flow through the
`createAgentProfile` / `updateAgentProfile` tRPC handlers, which call
`agentProviderService.saveAgentProvider()` and write a full provider definition —
**including the secret `apiKey`** — into the machine-home provider store
(`~/.kanban/settings/agent_providers.json`). So editing a profile silently doubles as
editing (or creating) a provider, from outside Settings.

This violates the single-source-of-truth goal: there must be exactly one place to define
providers and set the per-agent default, and that place is **Settings → Agent**.

## Goal

Make **Settings → Providers** (scoped per agent) the single source of truth for:

- adding a provider
- editing a provider definition (freeform — base URL, models, protocols, credentials)
- deleting a provider
- setting the per-agent **default** provider

Everywhere else may only **select** an already-defined provider; nothing else may create,
edit, or delete a provider definition or set the default.

The existing secret boundary is preserved unchanged: secrets (apiKey, OAuth tokens) live
only in the machine-home provider store; committed per-workspace shards
(`<repo>/.kanban/workspaces/<id>/agent-profiles/<id>.json`) hold non-secret config only.

## Decisions (approved)

- **Profile = pure reference.** Hard-remove `baseUrl`, `region`, `gcpProjectId`,
  `gcpRegion` from the profile contract, and `apiKey` from the profile create/update
  requests. A profile becomes `{ id, name, agentId, providerId, modelId, reasoningEffort }`.
- **Settings list backed by `listAgentProviders`** so it carries `defaultProviderId` and
  can render a "Default" badge + a "Set as default" action.
- **Per-agent scope.** Each agent manages its own provider set + default under
  Settings → Providers, via an agent picker. The backend provider store is already
  `agentId`-keyed.

## Design

### Mental model

```
Provider definition (freeform, secrets)      Profile (committed, non-secret)
─────────────────────────────────────        ─────────────────────────────────
machine-home: agent_providers.json            repo: agent-profiles/<id>.json
  per agent: providers[] + defaultProviderId    { id, name, agentId,
  each: baseUrl, apiKey, region, gcp,             providerId,   ← reference only
        protocols, models, reasoning, …           modelId,
                                                   reasoningEffort }
  ▲ edited ONLY in Settings → Providers         ▲ edited in composer profile editor
                                                  (provider is select-only)
```

At launch, `resolvePiLaunchConfig` resolves the profile's `providerId` against the
provider store for base URL / region / GCP / credentials; the profile no longer overrides
any of those.

### Backend changes

1. **`src/core/api-contract.ts`**
   - Remove `baseUrl`, `region`, `gcpProjectId`, `gcpRegion` from
     `RuntimeAgentProfileRecord`.
   - Remove `apiKey` from `RuntimeAgentProfileCreateRequest` /
     `RuntimeAgentProfileUpdateRequest`.
   - Remove the derived `apiKeyConfigured` from the `RuntimeAgentProfile` wire summary.
   - Confirm the profile schemas strip unknown keys (zod default) so old shards with the
     removed fields load clean — do **not** use `.strict()`.

2. **`src/core/api-validation.ts`** — update
   `parseAgentProfileCreateRequest` / `parseAgentProfileUpdateRequest` to drop the removed
   fields.

3. **`src/state/agent-profile-registry.ts` + `src/state/agent-profile-store.ts`** — drop
   the removed fields from the create/update ops and the persisted record shape.

4. **`src/trpc/runtime-api.ts`** — in `createAgentProfile` and `updateAgentProfile`,
   **delete the `agentProviderService.saveAgentProvider()` branch entirely.** Profiles no
   longer touch the provider store; they persist only the reference + model + reasoning +
   selection.

5. **`src/agent-sdk/kanban/pi-provider-config.ts`** (`resolvePiLaunchConfig`) — stop
   reading `profile.baseUrl` / `region` / `gcpProjectId` / `gcpRegion`. These resolve
   solely from the provider config. Keep taking `providerId` / `modelId` /
   `reasoningEffort` from the profile (and the existing per-session override layer above
   it).

6. **Provider CRUD endpoints** — `addProviderToAgent`, `removeProviderFromAgent`,
   `selectAgentProvider`, `listAgentProviders` already exist and are correct; no backend
   change beyond confirming `listAgentProviders` returns `providers[]` + `defaultProviderId`.

### Frontend changes

7. **`web-ui/src/components/agent-profiles/agent-profile-edit-dialog.tsx`** — remove the
   Base URL / API key / region / GCP fields, the managed-OAuth note, and the Vertex
   block. The editor renders **Name + Provider (select-only) + Model + Reasoning effort**.
   The provider `<select>` lists existing providers from the catalog; there is no create /
   edit affordance. Drop `MANAGED_OAUTH_PROVIDER_IDS` / `isManagedOauthProvider` /
   `isVertexProvider` and the corresponding `DraftState` fields.

8. **`web-ui/src/hooks/use-agent-profiles.ts` + `agent-profile-control.tsx`** — drop the
   removed fields from `AgentProfileCreateInput` and the update request, and from any
   call sites.

9. **`web-ui/src/components/runtime-settings-dialog.tsx`** — Settings → Providers becomes
   per-agent:
   - Add an agent picker (tabs or a select) at the top of the section; the list, Add,
     Edit, Delete, and Set-default all operate on the selected agent.
   - Switch the list data source to `listAgentProviders` (returns
     `{ agents: Record<agentId, { providers[], defaultProviderId? }> }`; index by the
     selected agent) so the list carries `defaultProviderId`.
   - Per provider row: keep **Edit**; add **Delete** (→ `removeProviderFromAgent`) and
     **Set as default** (→ `selectAgentProvider`); render a "Default" badge on the current
     default. Deleting the default falls back per existing backend behavior.
   - Keep the **Add Provider** button (opens `KanbanAddProviderDialog` for the selected
     agent).
   - Wire the `removeProviderFromAgent` / `selectAgentProvider` wrappers
     (`runtime-config-query.ts`) that currently have no UI callers.

### What does not change

- The `KanbanAddProviderDialog` freeform editor (the legitimate one).
- The machine-home secret store and the committed/non-secret boundary.
- The new-thread dialog (`home-thread-create-dialog.tsx`) — already agent-pick only.
- The profile concept itself — profiles remain, as selection-only bundles.
- Per-session provider selection (a card's `agentSettings.providerId`) — that is choosing,
  not defining, and stays.

## Migration

None required. After the contract change, existing committed profile shards that still
carry `baseUrl` / `region` / `gcp*` are stripped on read. The provider definition those
fields implied already exists in the machine-home provider store (profile-create mirrored
it there), so no provider data is lost. A profile that previously overrode a provider's
base URL now defers to the provider's own value — the intended single-source-of-truth
behavior.

## Testing

- **Backend (vitest where importable):**
  - `createAgentProfile` / `updateAgentProfile` no longer call `saveAgentProvider` (assert
    the provider store is untouched by a profile mutation).
  - An old-shape profile shard (with `baseUrl`/`region`/`gcp*`) loads and round-trips
    without those fields.
  - Registry create/update ops reject / ignore the removed fields.
- **Backend (Bun round-trip):** `resolvePiLaunchConfig` resolves base URL / region / GCP
  from the provider config and ignores any profile-level values — the pi service can't be
  imported under vitest.
- **Frontend:**
  - The profile edit dialog renders no credential / base-URL / region / GCP fields.
  - A Settings provider row's Delete calls `removeProviderFromAgent`; Set-default calls
    `selectAgentProvider`; the "Default" badge tracks `defaultProviderId`; the agent picker
    scopes the list.
- **Gate:** `web:typecheck` is the load-bearing check (narrowing the profile contract
  ripples into `web-ui` via the `@runtime-contract` alias). Backend `tsc` + vitest carry
  pre-existing failures — diff against a pristine baseline rather than expecting zero.
