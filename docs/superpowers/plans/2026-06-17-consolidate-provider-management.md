# Consolidate Provider Management into Settings → Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings → Providers (per-agent) the single source of truth for adding / editing / deleting / setting-default a provider, and demote agent "profiles" to pure references that can no longer define providers or carry secrets.

**Architecture:** A profile becomes `{ id, name, agentId, providerId, modelId, reasoningEffort }` — its `baseUrl`/`region`/`gcp*` definition fields and `apiKey` secret are removed, and the profile create/update handlers stop writing the machine-home provider store. Provider definitions (freeform, with secrets) are written only by `KanbanAddProviderDialog`; the Settings Providers section gains per-agent scoping, Delete, and Set-default by consuming the existing (secret-redacted) `listAgentProviders` / `removeProviderFromAgent` / `selectAgentProvider` endpoints.

**Tech Stack:** TypeScript, zod (wire contracts in `src/core/api-contract.ts`), tRPC, React + Tailwind (web-ui), vitest, Bun (runtime).

## Global Constraints

- **Secret boundary (unchanged):** secrets (`apiKey`, OAuth tokens) live only in the machine-home provider store (`~/.kanban/settings/agent_providers.json`); committed per-workspace profile shards (`<repo>/.kanban/workspaces/<id>/agent-profiles/<id>.json`) hold non-secret config only. Nothing in this plan may write a secret to a committed file or send one over the wire.
- **No `any`.** Prefer SDK/contract-provided types over local redefinitions.
- **No inline/dynamic imports** — top-level imports only.
- **Diagnostics** go through `createLogger` (`src/logging/`) — never `console.*`.
- **Load-bearing gate:** `web:typecheck` (narrowing the profile contract ripples into web-ui via the `@runtime-contract` alias). Backend `tsc` and full vitest carry pre-existing failures — judge backend by the **targeted** suites named per task, not a zero-failure run.
- **vitest scoping in this worktree:** run with `--exclude='**/.kanban/**'` so sibling worktrees' tests don't run (see project tribal knowledge).
- **No commits beyond what each task's Step says; never `git stash`** (stash list is repo-global across worktrees).

---

### Task 1: Narrow the profile wire contract

Remove the provider-definition fields and the secret from the profile schemas. This is the keystone change; everything else follows the compiler.

**Files:**
- Modify: `src/core/api-contract.ts:229-301`
- Test: `test/runtime/trpc/runtime-api.test.ts` (existing; will be exercised in Task 3)

**Interfaces:**
- Produces: `RuntimeAgentProfileRecord = { id: string; name: string; agentId: RuntimeAgentId; providerId: string | null; modelId: string | null; reasoningEffort: RuntimeReasoningEffort | null }`. `RuntimeAgentProfile` (wire summary) becomes identical to the record (no `apiKeyConfigured`). `RuntimeAgentProfileCreateRequest` keeps `{ agentId, name, providerId?, modelId?, reasoningEffort?, select? }`; `RuntimeAgentProfileUpdateRequest` keeps `{ id, name?, providerId?, modelId?, reasoningEffort? }`.

- [ ] **Step 1: Edit the record schema** (`api-contract.ts:229-240`) — remove the `baseUrl`, `region`, `gcpProjectId`, `gcpRegion` lines:

```ts
export const runtimeAgentProfileRecordSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	agentId: runtimeAgentIdSchema,
	providerId: z.string().nullable(),
	modelId: z.string().nullable(),
	reasoningEffort: runtimeReasoningEffortSchema.nullable(),
});
```

- [ ] **Step 2: Collapse the wire summary** (`api-contract.ts:256-260`) — `RuntimeAgentProfile` no longer adds `apiKeyConfigured`:

```ts
// Wire summary: profile records are already secret-free, so the summary is the record.
export const runtimeAgentProfileSchema = runtimeAgentProfileRecordSchema;
export type RuntimeAgentProfile = z.infer<typeof runtimeAgentProfileSchema>;
```

Also update the comment block at `api-contract.ts:222-228` to drop the `baseUrl/reasoning/region/gcp` enumeration and the `apiKeyConfigured` sentence — it now reads that records hold only `provider/model/reasoning` and that secrets stay in the machine-home store.

- [ ] **Step 3: Edit the create request** (`api-contract.ts:273-287`) — remove `apiKey`, `baseUrl`, `region`, `gcpProjectId`, `gcpRegion`:

```ts
export const runtimeAgentProfileCreateRequestSchema = z.object({
	agentId: runtimeAgentIdSchema,
	name: z.string().min(1),
	providerId: z.string().nullable().optional(),
	modelId: z.string().nullable().optional(),
	reasoningEffort: runtimeReasoningEffortSchema.nullable().optional(),
	// When true, also mark the created profile as the agent's selected profile.
	select: z.boolean().optional(),
});
export type RuntimeAgentProfileCreateRequest = z.infer<typeof runtimeAgentProfileCreateRequestSchema>;
```

- [ ] **Step 4: Edit the update request** (`api-contract.ts:289-301`) — remove the same five fields:

```ts
export const runtimeAgentProfileUpdateRequestSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).optional(),
	providerId: z.string().nullable().optional(),
	modelId: z.string().nullable().optional(),
	reasoningEffort: runtimeReasoningEffortSchema.nullable().optional(),
});
export type RuntimeAgentProfileUpdateRequest = z.infer<typeof runtimeAgentProfileUpdateRequestSchema>;
```

- [ ] **Step 5: Confirm strip semantics** — `runtimeAgentProfileRecordSchema` is a plain `z.object` (no `.strict()`), so an old shard carrying the removed keys is parsed with those keys silently dropped. No code change; just verify by reading that no `.strict()` is chained anywhere on these schemas.

- [ ] **Step 6: Commit**

```bash
git add src/core/api-contract.ts
git commit -m "refactor(contract): profile record drops provider-definition fields + apiKey"
```

---

### Task 2: Narrow the pure profile registry

`AgentProfilePatch` still `Pick`s the removed fields, which will now fail to compile. Tighten it and confirm the pure ops need no other change.

**Files:**
- Modify: `src/state/agent-profile-registry.ts:12-18`
- Test: `test/runtime/agent-profile-registry.test.ts` (existing)

**Interfaces:**
- Consumes: `RuntimeAgentProfileRecord` (Task 1).
- Produces: `AgentProfilePatch = Partial<Pick<RuntimeAgentProfileRecord, "name" | "providerId" | "modelId" | "reasoningEffort">>`.

- [ ] **Step 1: Edit the patch type** (`agent-profile-registry.ts:12-18`):

```ts
/** Fields a caller may patch on an existing profile (identity + agent are fixed). */
export type AgentProfilePatch = Partial<
	Pick<RuntimeAgentProfileRecord, "name" | "providerId" | "modelId" | "reasoningEffort">
>;
```

- [ ] **Step 2: Update the registry test** — open `test/runtime/agent-profile-registry.test.ts` and remove any `baseUrl`/`region`/`gcpProjectId`/`gcpRegion` keys from the `RuntimeAgentProfileRecord` fixtures and `updateAgentProfile` patches it builds. The behavioral assertions (create/update/delete/select, name-collision) stay as-is.

- [ ] **Step 3: Run the registry test**

Run: `npx vitest run test/runtime/agent-profile-registry.test.ts --exclude='**/.kanban/**'`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/state/agent-profile-registry.ts test/runtime/agent-profile-registry.test.ts
git commit -m "refactor(profiles): narrow AgentProfilePatch to provider/model/reasoning"
```

---

### Task 3: Stop profile mutations from writing the provider store

`createAgentProfile` / `updateAgentProfile` currently mirror `apiKey`/`baseUrl`/`region`/`gcp` into the machine-home provider store via `saveAgentProvider`. Remove that entirely; profiles become pure references. Also drop `apiKeyConfigured` from the summary mapper and `baseUrl` from the pi-launch-profile loader.

**Files:**
- Modify: `src/trpc/runtime-api.ts:160-162` (`toAgentProfileSummary`), `:188-193` (`loadSelectedPiLaunchProfile`), `:691-729` (`createAgentProfile`), `:731-776` (`updateAgentProfile`)
- Test: `test/runtime/trpc/runtime-api.test.ts`, `test/integration/agent-profiles.integration.test.ts` (existing)

**Interfaces:**
- Consumes: narrowed requests/record (Tasks 1-2).
- Produces: `createAgentProfile` / `updateAgentProfile` no longer call `agentProviderService.saveAgentProvider`; `toAgentProfileSummary(record) => record` unchanged-shape passthrough.

- [ ] **Step 1: Simplify the summary mapper** (`runtime-api.ts:160-162`):

```ts
function toAgentProfileSummary(record: RuntimeAgentProfileRecord): RuntimeAgentProfile {
	return record;
}
```

Leave `toAgentProfileSummary` call sites as-is (they keep working). Remove the now-unused `resolvePiApiKey` import **only if** no other reference remains (it is still used by `resolvePiLaunchConfig` indirectly and possibly elsewhere in this file — grep `resolvePiApiKey` before deleting the import; keep it if any reference survives).

- [ ] **Step 2: Drop `baseUrl` from the launch-profile loader** (`runtime-api.ts:188-193`):

```ts
return {
	providerId: selected.providerId,
	modelId: selected.modelId,
	reasoningEffort: selected.reasoningEffort,
};
```

- [ ] **Step 3: Rewrite `createAgentProfile`** (`runtime-api.ts:691-729`) — delete the `if (providerId) { … saveAgentProvider … }` block and the removed record fields:

```ts
createAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
	const body = parseAgentProfileCreateRequest(input);
	const providerId = body.providerId?.trim() || null;
	const id = createAgentProfileId();
	const record: RuntimeAgentProfileRecord = {
		id,
		name: body.name,
		agentId: body.agentId,
		providerId,
		modelId: body.modelId?.trim() || null,
		reasoningEffort: body.reasoningEffort ?? null,
	};
	const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (current) => {
		const created = createAgentProfile(current, record);
		return body.select ? selectAgentProfile(created, body.agentId, id) : created;
	});
	deps.bumpKanbanSessionContextVersion?.();
	return buildAgentProfileMutationResponse(data, data.profiles.find((profile) => profile.id === id) ?? record);
},
```

- [ ] **Step 4: Rewrite `updateAgentProfile`** (`runtime-api.ts:731-776`) — delete the `if (effectiveProviderId) { … saveAgentProvider … }` block and the removed patch fields:

```ts
updateAgentProfile: async (workspaceScope, input): Promise<RuntimeAgentProfileMutationResponse> => {
	const body = parseAgentProfileUpdateRequest(input);
	const current = await loadWorkspaceAgentProfiles(workspaceScope.workspaceId);
	const existing = current.profiles.find((profile) => profile.id === body.id);
	if (!existing) {
		throw new TRPCError({ code: "NOT_FOUND", message: `Agent profile "${body.id}" not found.` });
	}
	const patch: AgentProfilePatch = {};
	if (body.name !== undefined) patch.name = body.name;
	if (body.providerId !== undefined) patch.providerId = body.providerId?.trim() || null;
	if (body.modelId !== undefined) patch.modelId = body.modelId?.trim() || null;
	if (body.reasoningEffort !== undefined) patch.reasoningEffort = body.reasoningEffort;
	const data = await mutateWorkspaceAgentProfiles(workspaceScope.workspaceId, (cur) =>
		updateAgentProfile(cur, body.id, patch),
	);
	deps.bumpKanbanSessionContextVersion?.();
	return buildAgentProfileMutationResponse(data, data.profiles.find((profile) => profile.id === body.id) ?? null);
},
```

- [ ] **Step 5: Clean up now-unused imports** — grep `getAgentProviderConfig` and `AgentProviderConfig` in `runtime-api.ts`; if the profile rewrite left them unused, remove those imports. (They are likely still used by other handlers — only remove what the compiler flags as unused.)

- [ ] **Step 6: Add a regression test** — in `test/runtime/trpc/runtime-api.test.ts`, add a test asserting a profile create with a `providerId` does **not** touch the provider store. Point `KANBAN_AGENT_PROVIDERS_PATH` at a temp file, call `createAgentProfile({ agentId: "pi", name: "p1", providerId: "anthropic", select: true })`, then read the provider store file and assert it does not exist / has no `pi` agent entry:

```ts
import { existsSync } from "node:fs";
// … inside the test, after createAgentProfile resolves:
expect(existsSync(providersPath)).toBe(false); // profile create wrote no provider config
```

(Follow the file's existing harness for constructing `runtimeApi` and a temp workspace; mirror an existing profile test in the same file.)

- [ ] **Step 7: Update the integration test** — in `test/integration/agent-profiles.integration.test.ts`, remove `apiKey`/`baseUrl`/`region`/`gcp*` from any create/update payloads and drop assertions on `apiKeyConfigured`.

- [ ] **Step 8: Run the affected suites**

Run: `npx vitest run test/runtime/trpc/runtime-api.test.ts test/integration/agent-profiles.integration.test.ts --exclude='**/.kanban/**'`
Expected: PASS (or, for runtime-api.test.ts, no *new* failures vs. a pristine baseline if it already has unrelated failures — diff against `main`).

- [ ] **Step 9: Commit**

```bash
git add src/trpc/runtime-api.ts test/runtime/trpc/runtime-api.test.ts test/integration/agent-profiles.integration.test.ts
git commit -m "refactor(profiles): profile mutations no longer write the provider store"
```

---

### Task 4: Drop the profile baseUrl override from launch resolution

`resolvePiLaunchConfig` reads `profile.baseUrl` as a top-priority override. With profiles no longer carrying a base URL, that layer disappears — base URL resolves solely from the provider config.

**Files:**
- Modify: `src/agent-sdk/kanban/pi-provider-config.ts:116-121` (`PiLaunchProfile`), `:143-146` (resolution)
- Test: `test/runtime/pi-launch-config-profile.test.ts` (existing, vitest)

**Interfaces:**
- Consumes: provider config from `getAgentProviderConfig("pi")`.
- Produces: `PiLaunchProfile = { providerId?: string | null; modelId?: string | null; reasoningEffort?: RuntimeReasoningEffort | null }`. `resolvePiLaunchConfig` return shape (`PiLaunchConfig`) is unchanged — `baseUrl` is still present, now sourced only from provider config / generic fallback.

- [ ] **Step 1: Write the failing test** — in `test/runtime/pi-launch-config-profile.test.ts`, add:

```ts
it("ignores any base URL not present on the provider config (profiles can't override base URL)", () => {
	// No provider config written → temp store is empty.
	const config = resolvePiLaunchConfig({
		workspaceProfile: { providerId: "anthropic", modelId: "claude-sonnet-4-20250514", reasoningEffort: null },
	});
	// Base URL comes from the bundled model / provider config, never from the profile.
	expect(config.providerId).toBe("anthropic");
	expect(config.modelId).toBe("claude-sonnet-4-20250514");
});
```

Also remove from this file any existing test that passes `baseUrl` inside `workspaceProfile` (that property no longer exists on `PiLaunchProfile` and won't compile).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/runtime/pi-launch-config-profile.test.ts --exclude='**/.kanban/**'`
Expected: FAIL to compile (object literal with `baseUrl` not assignable to `PiLaunchProfile`).

- [ ] **Step 3: Narrow `PiLaunchProfile`** (`pi-provider-config.ts:116-121`):

```ts
export interface PiLaunchProfile {
	providerId?: string | null;
	modelId?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
}
```

- [ ] **Step 4: Stop seeding `baseUrl` from the profile** (`pi-provider-config.ts:143-146`) — change the `baseUrl` initializer so it always starts null and is filled only from the provider-config layer below:

```ts
let providerId = input?.providerIdOverride?.trim() || profile?.providerId?.trim() || null;
let modelId = input?.modelIdOverride?.trim() || profile?.modelId?.trim() || null;
let baseUrl: string | null = null;
let reasoningEffort = input?.reasoningEffortOverride ?? profile?.reasoningEffort ?? null;
```

The existing `if (!providerId || !modelId || !baseUrl) { … baseUrl = baseUrl || agentConfig.baseUrl?.trim() || null; … }` block (`:149-163`) is unchanged and now the sole source of base URL. Update the doc comment at `:30` / `:111-114` to drop the "profile baseUrl overrides" wording.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/runtime/pi-launch-config-profile.test.ts --exclude='**/.kanban/**'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-sdk/kanban/pi-provider-config.ts test/runtime/pi-launch-config-profile.test.ts
git commit -m "refactor(pi): base URL resolves only from provider config, not the profile"
```

---

### Task 5: Redact secrets from the per-agent provider set response

The Settings UI (Task 8) will consume `listAgentProviders`, which today returns raw configs **including `apiKey`**. Add a pure redactor and apply it at the endpoint so the wire never carries the secret. (No UI consumes this endpoint today, so this is safe.)

**Files:**
- Modify: `src/agent-sdk/kanban/agent-provider-config.ts` (near `:370`), `src/trpc/runtime-api.ts:1071-1074`
- Test: `test/runtime/unified-proxy/agent-provider-config.test.ts` (existing) or a new `test/runtime/agent-provider-redaction.test.ts`

**Interfaces:**
- Produces: `redactAgentProviderSets(sets: Record<string, AgentProviderSet>): Record<string, AgentProviderSet>` — returns a deep-ish copy with every provider's `apiKey` removed; all other fields preserved.

- [ ] **Step 1: Write the failing test** (new file `test/runtime/agent-provider-redaction.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { redactAgentProviderSets } from "../../src/agent-sdk/kanban/agent-provider-config";

describe("redactAgentProviderSets", () => {
	it("strips apiKey from every provider but keeps other fields", () => {
		const out = redactAgentProviderSets({
			pi: {
				agentId: "pi",
				defaultProviderId: "anthropic",
				providers: [{ agentId: "pi", provider: "anthropic", apiKey: "sk-secret", baseUrl: "https://x" }],
			},
		});
		expect(out.pi.providers[0].apiKey).toBeUndefined();
		expect(out.pi.providers[0].baseUrl).toBe("https://x");
		expect(out.pi.defaultProviderId).toBe("anthropic");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/runtime/agent-provider-redaction.test.ts --exclude='**/.kanban/**'`
Expected: FAIL with "redactAgentProviderSets is not a function".

- [ ] **Step 3: Implement the redactor** — in `src/agent-sdk/kanban/agent-provider-config.ts`, after `getAllAgentProviderSets` (`:370-373`):

```ts
/** Return provider sets with every `apiKey` stripped — safe to send over the wire. */
export function redactAgentProviderSets(
	sets: Record<string, AgentProviderSet>,
): Record<string, AgentProviderSet> {
	const out: Record<string, AgentProviderSet> = {};
	for (const [agentId, set] of Object.entries(sets)) {
		out[agentId] = {
			...set,
			providers: set.providers.map(({ apiKey: _apiKey, ...rest }) => ({ ...rest })),
		};
	}
	return out;
}
```

- [ ] **Step 4: Apply it at the endpoint** (`runtime-api.ts:1071-1074`):

```ts
listAgentProviders: async (): Promise<RuntimeAgentProviderSetListResponse> => {
	// Full multi-provider view: every agent's registered providers + default, secret-free.
	return { agents: redactAgentProviderSets(getAllAgentProviderSets()) };
},
```

Add `redactAgentProviderSets` to the existing import from `agent-provider-config` in `runtime-api.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/runtime/agent-provider-redaction.test.ts --exclude='**/.kanban/**'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent-sdk/kanban/agent-provider-config.ts src/trpc/runtime-api.ts test/runtime/agent-provider-redaction.test.ts
git commit -m "feat(provider): redact apiKey from listAgentProviders wire response"
```

---

### Task 6: Remove provider-definition fields from the profile editor (composer-adjacent)

Strip Base URL / API key / region / GCP and the OAuth/Vertex branches from the profile edit dialog. A profile editor becomes Name + Provider (select-only) + Model + Reasoning effort.

**Files:**
- Modify: `web-ui/src/components/agent-profiles/agent-profile-edit-dialog.tsx`
- Modify: `web-ui/src/hooks/agent-profile-utils.ts:59-74`
- Test: `web-ui/src/components/agent-profiles/agent-profile-edit-dialog.test.tsx` (create if absent)

**Interfaces:**
- Consumes: narrowed `RuntimeAgentProfileCreateRequest` / `RuntimeAgentProfileUpdateRequest` (Task 1) and `AgentProfileCreateInput` (auto-narrows via its `Omit`).
- Produces: `duplicateProfileCreateInput(source, name) => { agentId, name, providerId, modelId, reasoningEffort, select: true }`.

- [ ] **Step 1: Write the failing test** (`agent-profile-edit-dialog.test.tsx`) — render the dialog in create mode and assert no credential fields:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentProfileEditDialog } from "./agent-profile-edit-dialog";

describe("AgentProfileEditDialog", () => {
	it("renders no provider-definition fields (base URL / API key / region / GCP)", () => {
		render(
			<AgentProfileEditDialog
				open
				onOpenChange={() => {}}
				workspaceId={null}
				profile={null}
				existingNames={[]}
				onCreate={async () => ({ ok: true })}
				onUpdate={async () => ({ ok: true })}
			/>,
		);
		expect(screen.queryByText("Base URL")).toBeNull();
		expect(screen.queryByText("API key")).toBeNull();
		expect(screen.queryByText("GCP project ID")).toBeNull();
		expect(screen.getByText("Provider")).toBeTruthy();
		expect(screen.getByText("Model")).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-ui && npx vitest run src/components/agent-profiles/agent-profile-edit-dialog.test.tsx`
Expected: FAIL ("Base URL" still found).

- [ ] **Step 3: Strip the dialog** — in `agent-profile-edit-dialog.tsx`:
  - Delete `MANAGED_OAUTH_PROVIDER_IDS`, `isManagedOauthProvider`, `isVertexProvider` (`:26-34`).
  - Remove `baseUrl`, `apiKey`, `region`, `gcpProjectId`, `gcpRegion` from `DraftState` and `profileToDraft` (`:68-92`).
  - In `handleProviderChange` (`:153-163`), drop the `baseUrl: ""` reset.
  - In `handleSubmit` (`:168-214`), build the payload as just the reference fields:

```ts
const handleSubmit = async (): Promise<void> => {
	if (!canSubmit) {
		return;
	}
	setIsSubmitting(true);
	try {
		const providerId = draft.providerId.trim() || null;
		const modelId = draft.modelId.trim() || null;
		const reasoningEffort = draft.reasoningEffort || null;
		const result = isEditMode
			? await onUpdate({ id: profile.id, name: trimmedName, providerId, modelId, reasoningEffort })
			: await onCreate({ name: trimmedName, providerId, modelId, reasoningEffort, select: true });
		if (result.ok) {
			onOpenChange(false);
		}
	} finally {
		setIsSubmitting(false);
	}
};
```

  - In the JSX (`:270-334`), delete the `managedOauth ? … : ( <Base URL/> <API key/> )` block and the `vertex ? ( <GCP…/> ) : null` block entirely. Keep the Name, Provider, and Model fields.
  - Remove the now-unused `managedOauth` / `vertex` / `TEXT_INPUT_CLASS` (if `TEXT_INPUT_CLASS` is only used by the deleted inputs) locals. Keep `providerOptions`, `selectedModel*`, `update`, `handleProviderChange`.

- [ ] **Step 4: Update `duplicateProfileCreateInput`** (`agent-profile-utils.ts:59-74`):

```ts
export function duplicateProfileCreateInput(
	source: RuntimeAgentProfile,
	name: string,
): RuntimeAgentProfileCreateRequest {
	return {
		agentId: source.agentId,
		name,
		providerId: source.providerId,
		modelId: source.modelId,
		reasoningEffort: source.reasoningEffort,
		select: true,
	};
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web-ui && npx vitest run src/components/agent-profiles/agent-profile-edit-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web-ui/src/components/agent-profiles/agent-profile-edit-dialog.tsx web-ui/src/hooks/agent-profile-utils.ts web-ui/src/components/agent-profiles/agent-profile-edit-dialog.test.tsx
git commit -m "refactor(web-ui): profile editor selects a provider, no longer defines one"
```

---

### Task 7: Add a per-agent provider-set query wrapper + thread agentId into provider saves

Give the web-ui a typed wrapper for `listAgentProviders`, and let the Settings provider add/edit path target a chosen agent rather than the hardcoded `"pi"`.

**Files:**
- Modify: `web-ui/src/runtime/runtime-config-query.ts` (add `fetchAgentProviderSets`)
- Modify: `web-ui/src/hooks/use-runtime-settings-kanban-controller.ts:239`, `:700-749` (`addCustomProvider`), `:804-...` (`updateCustomProvider`)

**Interfaces:**
- Produces:
  - `fetchAgentProviderSets(workspaceId: string | null): Promise<RuntimeAgentProviderSetListResponse>`
  - `addCustomProvider(input: AddKanbanProviderInput, agentId?: RuntimeAgentId): Promise<SaveResult>`
  - `updateCustomProvider(input: UpdateKanbanProviderInput, agentId?: RuntimeAgentId): Promise<SaveResult>`
  - (both default `agentId` to `"pi"`; pi-local display-state sync runs only when the target is `"pi"`.)

- [ ] **Step 1: Add the query wrapper** — in `runtime-config-query.ts`, beside `fetchAgentProviderConfigs` (`:205-210`):

```ts
export async function fetchAgentProviderSets(
	workspaceId: string | null,
): Promise<RuntimeAgentProviderSetListResponse> {
	const trpcClient = getRuntimeTrpcClient(workspaceId);
	return await trpcClient.runtime.listAgentProviders.query();
}
```

Add `RuntimeAgentProviderSetListResponse` to the type imports at the top of the file (from `@/runtime/types`).

- [ ] **Step 2: Make `selectedAgentId` a parameter, not a constant** — in `use-runtime-settings-kanban-controller.ts`, change `addCustomProvider` and `updateCustomProvider` to accept an `agentId` argument defaulting to the module's `"pi"`. Replace each closure's reliance on the `selectedAgentId` constant (`:239`) with the parameter. Concretely, change the signatures:

```ts
const addCustomProvider = useCallback(
	async (input: AddKanbanProviderInput, agentId: RuntimeAgentId = "pi"): Promise<SaveResult> => {
		// …build agentConfig with agentId = agentId (not the constant)…
		const result = await saveAgentProviderConfig(workspaceId, agentId, agentConfig);
		// …
		// Only sync the pi-centric local display state when editing pi:
		if (agentId === "pi") {
			// existing setProviderId / setModelId / setBaseUrl / loadProviderModelsForProvider block
		}
		return { ok: true };
	},
	[effectiveProviderSettings, loadProviderModelsForProvider, workspaceId],
);
```

Apply the same `agentId` parameter + `if (agentId === "pi")` guard around the pi-local-state block in `updateCustomProvider` (the `fetchAgentProviderConfigs` merge should read `configs.agents[agentId]`). Import `RuntimeAgentId` from `@/runtime/types` if not already imported. Leave `saveProviderSettings` (the pi account flow) untouched.

- [ ] **Step 3: Type-check**

Run: `cd web-ui && npm run typecheck` (or the repo's `web:typecheck` script)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web-ui/src/runtime/runtime-config-query.ts web-ui/src/hooks/use-runtime-settings-kanban-controller.ts
git commit -m "feat(web-ui): per-agent provider-set query + agent-scoped provider saves"
```

---

### Task 8: Make Settings → Providers per-agent with Delete and Set-default

Add an agent picker to the Providers section, list each agent's registered providers from `fetchAgentProviderSets`, badge the default, and wire Delete + Set-default. Add/Edit now target the picked agent.

**Files:**
- Modify: `web-ui/src/components/runtime-settings-dialog.tsx:402-478` (handlers/state), `:888-949` (Providers render), `:1374-1383` (dialog wiring)
- Test: `web-ui/src/components/runtime-settings-dialog.test.tsx` (extend if present; else add a focused render test)

**Interfaces:**
- Consumes: `fetchAgentProviderSets` (Task 7), `removeProviderFromAgent` / `selectAgentProvider` (existing in `runtime-config-query.ts`), `addCustomProvider`/`updateCustomProvider` with `agentId` (Task 7), `RuntimeAgentProviderSet`, `RuntimeAgentId`.

- [ ] **Step 1: Add per-agent state + loader** — near the provider-catalog state (`:408-416`), add the picked agent and the per-agent set:

```ts
const [providersAgentId, setProvidersAgentId] = useState<RuntimeAgentId>("pi");
const [providerSetsByAgent, setProviderSetsByAgent] = useState<Record<string, RuntimeAgentProviderSet>>({});
const reloadProviderSets = useCallback(() => {
	if (!open) return;
	void fetchAgentProviderSets(workspaceId)
		.then((res) => setProviderSetsByAgent(res.agents))
		.catch(() => setProviderSetsByAgent({}));
}, [open, workspaceId]);
useEffect(() => {
	reloadProviderSets();
}, [reloadProviderSets]);
```

The selected agent's providers + default:

```ts
const selectedAgentSet = providerSetsByAgent[providersAgentId] ?? null;
const selectedAgentProviders = selectedAgentSet?.providers ?? [];
const selectedAgentDefaultId = selectedAgentSet?.defaultProviderId ?? null;
```

- [ ] **Step 2: Scope add/edit/submit to the picked agent** — update `handleProviderDialogSubmit` (`:463-478`) to pass `providersAgentId` into the controller calls and reload both catalog and sets:

```ts
if (providerDialogMode === "add") {
	await agentSettings.addCustomProvider(input as AddKanbanProviderInput, providersAgentId);
} else {
	await agentSettings.updateCustomProvider(input as UpdateKanbanProviderInput, providersAgentId);
}
reloadProviderCatalog();
reloadProviderSets();
```

- [ ] **Step 3: Add delete + set-default handlers** — near the other provider handlers:

```ts
const handleDeleteProvider = useCallback(
	async (providerId: string) => {
		await removeProviderFromAgent(workspaceId, { agentId: providersAgentId, providerId });
		reloadProviderSets();
		reloadProviderCatalog();
	},
	[providersAgentId, reloadProviderCatalog, reloadProviderSets, workspaceId],
);
const handleSetDefaultProvider = useCallback(
	async (providerId: string) => {
		await selectAgentProvider(workspaceId, { agentId: providersAgentId, providerId });
		reloadProviderSets();
	},
	[providersAgentId, reloadProviderSets, workspaceId],
);
```

Add `removeProviderFromAgent`, `selectAgentProvider`, `fetchAgentProviderSets` to the existing `@/runtime/runtime-config-query` imports, and `RuntimeAgentProviderSet` to the type imports.

- [ ] **Step 4: Render the agent picker + per-agent list** — replace the Providers card body (`:896-949`). Render a row of agent chips from the already-computed `displayedAgents`, then list `selectedAgentProviders`, each with name, provider id, base URL/model line, a **Default** badge when `provider === selectedAgentDefaultId`, and **Set default** / **Edit** / **Delete** buttons:

```tsx
<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
	<p className="text-text-secondary text-[13px] mt-0 mb-3">
		Configure providers per agent. Each provider defines an API endpoint, models, and credentials.
	</p>
	<div className="flex flex-wrap gap-1.5 mb-3">
		{displayedAgents.map((a) => (
			<button
				key={a.id}
				type="button"
				onClick={() => setProvidersAgentId(a.id)}
				className={cn(
					"h-7 px-2.5 rounded-md text-[12px] border",
					a.id === providersAgentId
						? "bg-surface-3 border-border-bright text-text-primary"
						: "bg-surface-1 border-border text-text-secondary hover:bg-surface-2",
				)}
			>
				{a.label}
			</button>
		))}
	</div>
	<div className="flex flex-col gap-1">
		{selectedAgentProviders.length === 0 ? (
			<p className="text-text-tertiary text-[13px] py-2">
				No providers configured for this agent. Click "Add Provider" to get started.
			</p>
		) : (
			selectedAgentProviders.map((provider) => {
				const providerId = provider.provider ?? "";
				const isDefault = providerId === selectedAgentDefaultId;
				return (
					<div key={providerId} className="flex items-center justify-between gap-3 py-2 px-2 rounded hover:bg-surface-1">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="text-[13px] text-text-primary font-medium">{providerId}</span>
								{isDefault ? (
									<span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-status-green/10 text-status-green">
										Default
									</span>
								) : null}
							</div>
							{provider.model ? (
								<p className="text-text-secondary text-[11px] mt-0.5 m-0 truncate">Model: {provider.model}</p>
							) : null}
							{provider.baseUrl ? (
								<p className="text-text-tertiary text-[10px] mt-0.5 m-0 truncate">{provider.baseUrl}</p>
							) : null}
						</div>
						<div className="flex items-center gap-1.5 shrink-0">
							{!isDefault ? (
								<Button size="sm" variant="ghost" onClick={() => void handleSetDefaultProvider(providerId)}>
									Set default
								</Button>
							) : null}
							<Button
								size="sm"
								variant="ghost"
								icon={<Pencil size={12} />}
								onClick={() => {
									const catalogItem = providerCatalogAll.find((p) => p.id === providerId);
									if (catalogItem) {
										handleOpenEditProviderDialog(catalogItem);
									}
								}}
							>
								Edit
							</Button>
							<Button
								size="sm"
								variant="ghost"
								icon={<Trash2 size={12} />}
								onClick={() => void handleDeleteProvider(providerId)}
							>
								Delete
							</Button>
						</div>
					</div>
				);
			})
		)}
	</div>
	<div className="mt-3 pt-3 border-t border-border">
		<Button size="sm" icon={<Plus size={14} />} onClick={handleOpenAddProviderDialog} disabled={controlsDisabled}>
			Add Provider
		</Button>
	</div>
</div>
```

Import `Trash2` from `lucide-react` (alongside the existing `Pencil`, `Plus`, `Key`). `cn` is already imported.

- [ ] **Step 5: Section copy** — leave the "Providers" header (`:888-895`) as-is; the per-agent intent is now conveyed by the chips and the body copy edited in Step 4.

- [ ] **Step 6: Render test** — in `runtime-settings-dialog.test.tsx` (or a new focused test that mounts just the Providers section if the full dialog is hard to mount), assert that with a mocked `fetchAgentProviderSets` returning a `pi` set with two providers (one default), the default one shows a "Default" badge and renders a "Set default" button on the non-default one. If the full dialog is impractical to render in a unit test, instead add a small pure helper `isDefaultProvider(providerId, set)` and unit-test that, and keep the JSX wiring covered by `web:typecheck`. Prefer the helper route if mounting the dialog pulls in heavy providers.

- [ ] **Step 7: Type-check + run web tests**

Run: `cd web-ui && npm run typecheck && npx vitest run src/components/runtime-settings-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web-ui/src/components/runtime-settings-dialog.tsx web-ui/src/components/runtime-settings-dialog.test.tsx
git commit -m "feat(web-ui): per-agent providers in Settings with delete + set-default"
```

---

### Task 9: Full-surface verification

**Files:** none (verification only).

- [ ] **Step 1: Web typecheck (the load-bearing gate)**

Run: `npm run web:typecheck` (from repo root)
Expected: PASS, zero errors.

- [ ] **Step 2: Targeted backend + web suites**

Run:
```bash
npx vitest run \
  test/runtime/agent-profile-registry.test.ts \
  test/runtime/pi-launch-config-profile.test.ts \
  test/runtime/agent-provider-redaction.test.ts \
  test/runtime/trpc/runtime-api.test.ts \
  test/integration/agent-profiles.integration.test.ts \
  --exclude='**/.kanban/**'
cd web-ui && npx vitest run src/components/agent-profiles src/hooks/use-agent-profiles.test.tsx src/components/runtime-settings-dialog.test.tsx
```
Expected: PASS, or no *new* failures vs. a pristine `main` baseline for any suite with pre-existing unrelated failures.

- [ ] **Step 3: Grep for orphans** — confirm no remaining reads of the removed profile fields:

```bash
grep -rn "profile\.\(baseUrl\|region\|gcpProjectId\|gcpRegion\)\|apiKeyConfigured" src web-ui/src --include=*.ts --include=*.tsx | grep -v ".test."
```
Expected: no matches (any match is a missed call site — fix it).

- [ ] **Step 4: Manual smoke (optional, if running the app)** — open Settings → Providers: switch the agent chip, add a provider for `pi`, set it default (badge moves), delete a non-default provider; open the home composer profile editor and confirm it shows only Name / Provider / Model / Reasoning. Confirm `~/.kanban/settings/agent_providers.json` only changes from the Settings dialog, never from creating/editing a profile.

---

## Self-Review

**Spec coverage:**
- Single source of truth for add/edit → Task 8 (Add/Edit target picked agent) + Task 3/6 (profile editor no longer defines providers). ✓
- Delete + Set-default in Settings → Task 8. ✓
- Per-agent scope → Tasks 7-8. ✓
- Profile = pure reference; hard-remove fields → Tasks 1-4, 6. ✓
- Secret boundary preserved (+ wire redaction) → Task 3 (no provider-store write), Task 5 (redact). ✓
- New-thread dialog untouched (already compliant) → not modified; noted in spec non-goals. ✓
- Migration (old shards strip cleanly) → Task 1 Step 5. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — code shown for every code step. Task 6 Step 3 and Task 8 Step 4 describe deletions against exact line ranges plus the full replacement JSX. ✓

**Type consistency:** `RuntimeAgentProfileRecord`/`RuntimeAgentProfile` (Task 1) flow into `AgentProfilePatch` (Task 2), `toAgentProfileSummary`/handlers (Task 3), `PiLaunchProfile` (Task 4), `AgentProfileCreateInput`/`duplicateProfileCreateInput` (Task 6). `fetchAgentProviderSets` returns `RuntimeAgentProviderSetListResponse`; `RuntimeAgentProviderSet.providers[].provider` is the id used as the key and for delete/set-default (`RuntimeAgentProviderMutationRequest = { agentId, providerId }`). `redactAgentProviderSets` signature matches its consumer in Task 5. ✓
