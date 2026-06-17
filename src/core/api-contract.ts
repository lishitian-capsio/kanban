import { z } from "zod";
import { resolveTaskTitle } from "./task-title.js";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "gemini", "opencode", "droid", "kiro", "pi"]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "trash"]);
export const runtimeBoardColumnIdSchema = z.preprocess(
	(val) => (val === "done" ? "trash" : val),
	runtimeBoardColumnIdEnum,
);
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdEnum>;

const runtimeTaskAutoReviewModeEnum = z.enum(["commit", "pr"]);
export const runtimeTaskAutoReviewModeSchema = z.preprocess(
	(val) => (val === "move_to_trash" || val === "move_to_done" ? "commit" : val),
	runtimeTaskAutoReviewModeEnum,
);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeEnum>;

export const runtimeReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type RuntimeReasoningEffort = z.infer<typeof runtimeReasoningEffortSchema>;
export const runtimeTaskAgentSettingsSchema = z.object({
	providerId: z.string().optional(),
	modelId: z.string().optional(),
	reasoningEffort: runtimeReasoningEffortSchema.optional(),
});
export type RuntimeTaskAgentSettings = z.infer<typeof runtimeTaskAgentSettingsSchema>;
export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

// A task's responsible person ("owner"), captured as a git identity (the same
// name/email pair git uses for authorship). Stamped once, at creation, from the
// creator's git identity (explicit CLI `--owner` wins; otherwise the workspace repo's
// `git config user.name` / `user.email`); either field may be empty when the repo has
// only one configured. It is NEVER backfilled afterwards — an ownerless task stays
// ownerless on every read/write, so real authorship is preserved.
export const runtimeTaskOwnerSchema = z.object({
	name: z.string(),
	email: z.string(),
});
export type RuntimeTaskOwner = z.infer<typeof runtimeTaskOwnerSchema>;

// The current git identity resolved from the workspace repo (`git config
// user.name`/`user.email`), or null when neither is configured. The web-ui reads this
// to stamp the creator onto a new task at creation time.
export const runtimeGitUserIdentityResponseSchema = z.object({
	identity: runtimeTaskOwnerSchema.nullable(),
});
export type RuntimeGitUserIdentityResponse = z.infer<typeof runtimeGitUserIdentityResponseSchema>;

// Durable task spec fields, pre-title-resolution. Exported so the on-disk sharded
// task store (src/state/task-shard-store.ts) can extend this exact shape with its
// storage-only fields (column, rank, dependsOn) instead of redefining the columns.
export const runtimeBoardCardObjectSchema = z.object({
	id: z.string(),
	title: z.string().optional(),
	prompt: z.string(),
	startInPlanMode: z.boolean(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	agentId: runtimeAgentIdSchema.optional(),
	agentSettings: runtimeTaskAgentSettingsSchema.optional(),
	owner: runtimeTaskOwnerSchema.optional(),
	baseRef: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});

export const runtimeBoardCardSchema = runtimeBoardCardObjectSchema.transform((card) => {
	return {
		...card,
		title: resolveTaskTitle(card.title, card.prompt),
	};
});
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z.object({
	columns: z.array(runtimeBoardColumnSchema),
	dependencies: z.array(runtimeBoardDependencySchema).default([]),
});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

// Requirement priority is the one piece of the legacy requirement contract that
// outlives the subsystem: the vault `requirement` document type reuses it for its
// `priority` frontmatter field (see `src/vault/vault-types.ts`).
export const runtimeRequirementPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type RuntimeRequirementPriority = z.infer<typeof runtimeRequirementPrioritySchema>;

// The vault-era "problem state" of a requirement: a requirement faces the
// customer, so its states describe the *problem*, not delivery — proposed (在提) |
// clarified (已澄清) | parked (搁置) | invalid (失效). Lives in the frontmatter of a
// `requirement` vault document.
export const runtimeRequirementProblemStatusSchema = z.enum(["proposed", "clarified", "parked", "invalid"]);
export type RuntimeRequirementProblemStatus = z.infer<typeof runtimeRequirementProblemStatusSchema>;

// A single home sidebar chat thread. `id` is the thread id (the fourth segment
// of the home agent session id), NOT the full synthetic session id. Each thread
// is bound to one agent; the full session id is derived via
// `createHomeAgentSessionId(workspaceId, agentId, id)`.
export const runtimeHomeChatThreadSchema = z.object({
	id: z.string(),
	agentId: runtimeAgentIdSchema,
	name: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeHomeChatThread = z.infer<typeof runtimeHomeChatThreadSchema>;

export const runtimeHomeChatThreadsDataSchema = z.object({
	threads: z.array(runtimeHomeChatThreadSchema).default([]),
});
export type RuntimeHomeChatThreadsData = z.infer<typeof runtimeHomeChatThreadsDataSchema>;

export const runtimeHomeChatThreadsListResponseSchema = z.object({
	ok: z.boolean(),
	threads: z.array(runtimeHomeChatThreadSchema),
	error: z.string().optional(),
});
export type RuntimeHomeChatThreadsListResponse = z.infer<typeof runtimeHomeChatThreadsListResponseSchema>;

export const runtimeHomeChatThreadCreateRequestSchema = z.object({
	name: z.string(),
	// Optional: the agent bound to this thread. Defaults to the workspace's selectedAgentId.
	agentId: runtimeAgentIdSchema.optional(),
});
export type RuntimeHomeChatThreadCreateRequest = z.infer<typeof runtimeHomeChatThreadCreateRequestSchema>;

export const runtimeHomeChatThreadRenameRequestSchema = z.object({
	id: z.string(),
	name: z.string(),
});
export type RuntimeHomeChatThreadRenameRequest = z.infer<typeof runtimeHomeChatThreadRenameRequestSchema>;

export const runtimeHomeChatThreadCloseRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeHomeChatThreadCloseRequest = z.infer<typeof runtimeHomeChatThreadCloseRequestSchema>;

// Shared by create/rename/close — each returns the affected thread (close → the removed thread).
export const runtimeHomeChatThreadMutationResponseSchema = z.object({
	ok: z.boolean(),
	thread: runtimeHomeChatThreadSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeHomeChatThreadMutationResponse = z.infer<typeof runtimeHomeChatThreadMutationResponseSchema>;

// ---------------------------------------------------------------------------
// Files library
//
// A first-class resource library, on par with Requirements, that any agent
// (pi / CLI) can reference. Unlike requirements (per-workspace JSON embedded in
// workspace-state), the file library is repo-scoped: content lives under
// `<repo>/.kanban/files/` and is committed to git (binaries via Git LFS), so a
// fresh clone is immediately usable. The manifest below is the index; the bytes
// live next to it in `blobs/<id>/<name>`.
// ---------------------------------------------------------------------------

// Coarse mime-derived bucket used for grouping/filtering in the UI and CLI.
export const runtimeFileCategorySchema = z.enum(["image", "document", "audio", "video", "archive", "text", "other"]);
export type RuntimeFileCategory = z.infer<typeof runtimeFileCategorySchema>;

export const runtimeFileItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	mime: z.string(),
	category: runtimeFileCategorySchema,
	size: z.number().int().nonnegative(),
	addedAt: z.number(),
});
export type RuntimeFileItem = z.infer<typeof runtimeFileItemSchema>;

export const runtimeFilesDataSchema = z.object({
	items: z.array(runtimeFileItemSchema).default([]),
});
export type RuntimeFilesData = z.infer<typeof runtimeFilesDataSchema>;

export const runtimeFilesListResponseSchema = z.object({
	files: z.array(runtimeFileItemSchema),
});
export type RuntimeFilesListResponse = z.infer<typeof runtimeFilesListResponseSchema>;

export const runtimeFileGetRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeFileGetRequest = z.infer<typeof runtimeFileGetRequestSchema>;

export const runtimeFileGetResponseSchema = z.object({
	file: runtimeFileItemSchema.nullable(),
});
export type RuntimeFileGetResponse = z.infer<typeof runtimeFileGetResponseSchema>;

export const runtimeFileAddRequestSchema = z.object({
	name: z.string(),
	// Base64-encoded file content.
	data: z.string(),
	mime: z.string().optional(),
});
export type RuntimeFileAddRequest = z.infer<typeof runtimeFileAddRequestSchema>;

export const runtimeFileAddResponseSchema = z.object({
	file: runtimeFileItemSchema,
});
export type RuntimeFileAddResponse = z.infer<typeof runtimeFileAddResponseSchema>;

export const runtimeFileUpdateRequestSchema = z.object({
	id: z.string(),
	name: z.string(),
});
export type RuntimeFileUpdateRequest = z.infer<typeof runtimeFileUpdateRequestSchema>;

export const runtimeFileUpdateResponseSchema = z.object({
	file: runtimeFileItemSchema,
});
export type RuntimeFileUpdateResponse = z.infer<typeof runtimeFileUpdateResponseSchema>;

export const runtimeFileDeleteRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeFileDeleteRequest = z.infer<typeof runtimeFileDeleteRequestSchema>;

export const runtimeFileDeleteResponseSchema = z.object({
	deleted: z.boolean(),
});
export type RuntimeFileDeleteResponse = z.infer<typeof runtimeFileDeleteResponseSchema>;

export const runtimeFileBytesRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeFileBytesRequest = z.infer<typeof runtimeFileBytesRequestSchema>;

export const runtimeFileBytesResponseSchema = z.object({
	file: runtimeFileItemSchema.nullable(),
	// Base64-encoded file content, ready for inline agent vision content.
	data: z.string().nullable(),
	mimeType: z.string().nullable(),
});
export type RuntimeFileBytesResponse = z.infer<typeof runtimeFileBytesResponseSchema>;

export const runtimeFilePathRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeFilePathRequest = z.infer<typeof runtimeFilePathRequestSchema>;

export const runtimeFilePathResponseSchema = z.object({
	file: runtimeFileItemSchema.nullable(),
	absolutePath: z.string().nullable(),
	// Path relative to the repo root, stable across every worktree checkout.
	relativePath: z.string().nullable(),
});
export type RuntimeFilePathResponse = z.infer<typeof runtimeFilePathResponseSchema>;

// ---------------------------------------------------------------------------
// Vault documents
//
// The readable (markdown + YAML frontmatter) channel of the vault, sibling to
// the binary file library above. A document is a plain `.md` file under
// `<repo>/.kanban/files/docs/<type>/<slug>-<id>.md`; frontmatter (`_id`/`type`)
// is the source of truth, so documents are scanned rather than manifested. This
// wire contract mirrors the engine model in `src/vault/vault-document.ts`,
// promoting `title` out of frontmatter and attaching store-supplied location +
// timestamps. The family is additive (B2): the binary `RuntimeFileItem` path and
// the legacy `RuntimeRequirement*` types are untouched.
// ---------------------------------------------------------------------------

// A frontmatter value round-tripped faithfully: a scalar, null, or an array of
// scalars. Nested maps are outside the model (the engine coerces richer values
// to strings), matching `VaultFrontmatterValue`.
export const runtimeVaultFrontmatterValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
export type RuntimeVaultFrontmatterValue = z.infer<typeof runtimeVaultFrontmatterValueSchema>;

export const runtimeVaultDocumentSchema = z.object({
	id: z.string(),
	type: z.string(),
	title: z.string(),
	// Markdown body (the document content), excludes frontmatter.
	body: z.string(),
	// Every frontmatter key except the promoted `_id`/`type` identity fields.
	frontmatter: z.record(z.string(), runtimeVaultFrontmatterValueSchema),
	// Path relative to the repo root, stable across every worktree checkout.
	relativePath: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeVaultDocument = z.infer<typeof runtimeVaultDocumentSchema>;

export const runtimeVaultDocumentsListRequestSchema = z.object({
	// Optional type filter (e.g. "requirement"); omitted lists every type.
	type: z.string().optional(),
});
export type RuntimeVaultDocumentsListRequest = z.infer<typeof runtimeVaultDocumentsListRequestSchema>;

export const runtimeVaultDocumentsListResponseSchema = z.object({
	documents: z.array(runtimeVaultDocumentSchema),
});
export type RuntimeVaultDocumentsListResponse = z.infer<typeof runtimeVaultDocumentsListResponseSchema>;

export const runtimeVaultDocumentGetRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeVaultDocumentGetRequest = z.infer<typeof runtimeVaultDocumentGetRequestSchema>;

export const runtimeVaultDocumentGetResponseSchema = z.object({
	document: runtimeVaultDocumentSchema.nullable(),
});
export type RuntimeVaultDocumentGetResponse = z.infer<typeof runtimeVaultDocumentGetResponseSchema>;

export const runtimeVaultDocumentCreateRequestSchema = z.object({
	type: z.string(),
	title: z.string(),
	body: z.string().optional(),
	frontmatter: z.record(z.string(), runtimeVaultFrontmatterValueSchema).optional(),
});
export type RuntimeVaultDocumentCreateRequest = z.infer<typeof runtimeVaultDocumentCreateRequestSchema>;

export const runtimeVaultDocumentCreateResponseSchema = z.object({
	document: runtimeVaultDocumentSchema,
});
export type RuntimeVaultDocumentCreateResponse = z.infer<typeof runtimeVaultDocumentCreateResponseSchema>;

export const runtimeVaultDocumentUpdateRequestSchema = z.object({
	id: z.string(),
	// Patch semantics: omitted fields are left unchanged. `frontmatter` is merged
	// key-wise by the store (title re-slug + git-rename happen there).
	title: z.string().optional(),
	body: z.string().optional(),
	frontmatter: z.record(z.string(), runtimeVaultFrontmatterValueSchema).optional(),
});
export type RuntimeVaultDocumentUpdateRequest = z.infer<typeof runtimeVaultDocumentUpdateRequestSchema>;

export const runtimeVaultDocumentUpdateResponseSchema = z.object({
	document: runtimeVaultDocumentSchema,
});
export type RuntimeVaultDocumentUpdateResponse = z.infer<typeof runtimeVaultDocumentUpdateResponseSchema>;

export const runtimeVaultDocumentDeleteRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeVaultDocumentDeleteRequest = z.infer<typeof runtimeVaultDocumentDeleteRequestSchema>;

export const runtimeVaultDocumentDeleteResponseSchema = z.object({
	deleted: z.boolean(),
});
export type RuntimeVaultDocumentDeleteResponse = z.infer<typeof runtimeVaultDocumentDeleteResponseSchema>;

// Where a `[[wikilink]]` was found in a document: in a named frontmatter field
// (the field is the relationship type, e.g. `customer`) or in the markdown body.
export const runtimeVaultLinkSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("frontmatter"), field: z.string() }),
	z.object({ kind: z.literal("body") }),
]);
export type RuntimeVaultLinkSource = z.infer<typeof runtimeVaultLinkSourceSchema>;

// A link going *out* of a document, with its resolution status. `resolved*` is
// null when the target matches no document by title, alias, or slug.
export const runtimeVaultOutgoingLinkSchema = z.object({
	target: z.string(),
	label: z.string().optional(),
	source: runtimeVaultLinkSourceSchema,
	resolvedId: z.string().nullable(),
	resolvedType: z.string().nullable(),
	resolvedTitle: z.string().nullable(),
});
export type RuntimeVaultOutgoingLink = z.infer<typeof runtimeVaultOutgoingLinkSchema>;

// A link coming *into* a document (who links to me), identifying the source doc
// and the field/body it linked from so a panel can group by relationship.
export const runtimeVaultBacklinkSchema = z.object({
	sourceId: z.string(),
	sourceType: z.string(),
	sourceTitle: z.string(),
	source: runtimeVaultLinkSourceSchema,
	label: z.string().optional(),
});
export type RuntimeVaultBacklink = z.infer<typeof runtimeVaultBacklinkSchema>;

export const runtimeVaultDocumentLinksGetRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeVaultDocumentLinksGetRequest = z.infer<typeof runtimeVaultDocumentLinksGetRequestSchema>;

export const runtimeVaultDocumentLinksGetResponseSchema = z.object({
	outgoing: z.array(runtimeVaultOutgoingLinkSchema),
	backlinks: z.array(runtimeVaultBacklinkSchema),
});
export type RuntimeVaultDocumentLinksGetResponse = z.infer<typeof runtimeVaultDocumentLinksGetResponseSchema>;

// Full-text search across the vault. The runtime scans the doc store (no separate
// index) and scores each match by position — a title hit outranks a frontmatter
// keyword hit, which outranks a body hit — so callers get a relevance-ordered
// list with a snippet to render. `field` reports where the strongest hit landed.
export const runtimeVaultSearchMatchFieldSchema = z.enum(["title", "frontmatter", "body"]);
export type RuntimeVaultSearchMatchField = z.infer<typeof runtimeVaultSearchMatchFieldSchema>;

export const runtimeVaultSearchRequestSchema = z.object({
	query: z.string(),
	// Optional type filter (e.g. "requirement"); omitted searches every type.
	type: z.string().optional(),
	// Cap on returned results (defaults applied server-side).
	limit: z.number().int().positive().optional(),
});
export type RuntimeVaultSearchRequest = z.infer<typeof runtimeVaultSearchRequestSchema>;

export const runtimeVaultSearchResultSchema = z.object({
	id: z.string(),
	type: z.string(),
	title: z.string(),
	// Path relative to the repo root, stable across every worktree checkout.
	relativePath: z.string(),
	// Higher is a stronger match; ordering, not an absolute scale.
	score: z.number(),
	// Where the strongest hit landed, for the result's secondary label/icon.
	field: runtimeVaultSearchMatchFieldSchema,
	// A short excerpt around the match, suitable for rendering under the title.
	snippet: z.string(),
	updatedAt: z.number(),
});
export type RuntimeVaultSearchResult = z.infer<typeof runtimeVaultSearchResultSchema>;

export const runtimeVaultSearchResponseSchema = z.object({
	results: z.array(runtimeVaultSearchResultSchema),
});
export type RuntimeVaultSearchResponse = z.infer<typeof runtimeVaultSearchResponseSchema>;

// ---------------------------------------------------------------------------
// Vault settings
//
// Workspace-level vault preferences. `managed` is the vault-takeover switch: when
// false (the default), the sidebar agent only reads/writes vault documents under
// an explicit instruction — it never acts on its own. When true, the agent is
// authorized to proactively create and maintain vault documents at appropriate
// moments, following each type's self-governing authoring prompt. The setting is
// repo-scoped and committed alongside the docs (`<repo>/.kanban/files/
// settings.json`), so it travels with the vault.
// ---------------------------------------------------------------------------

export const runtimeVaultSettingsSchema = z.object({
	managed: z.boolean().default(false),
});
export type RuntimeVaultSettings = z.infer<typeof runtimeVaultSettingsSchema>;

export const runtimeVaultSettingsGetResponseSchema = z.object({
	settings: runtimeVaultSettingsSchema,
});
export type RuntimeVaultSettingsGetResponse = z.infer<typeof runtimeVaultSettingsGetResponseSchema>;

export const runtimeVaultSettingsUpdateRequestSchema = z.object({
	managed: z.boolean(),
});
export type RuntimeVaultSettingsUpdateRequest = z.infer<typeof runtimeVaultSettingsUpdateRequestSchema>;

export const runtimeVaultSettingsUpdateResponseSchema = z.object({
	settings: runtimeVaultSettingsSchema,
});
export type RuntimeVaultSettingsUpdateResponse = z.infer<typeof runtimeVaultSettingsUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// Vault saved views & filter expressions
//
// A *view* is a saved way of looking at one document type: an optional filter
// expression, a sort, a layout, and which properties to show. Views are
// repo-scoped and committed alongside the docs (`<repo>/.kanban/files/views/
// <id>.json`), so they travel with the vault and don't cause cross-branch merge
// conflicts (one file per view, like the task shards). The filter model mirrors
// tolaria's: a recursive `FilterGroup` of `all` (AND) / `any` (OR) nodes, where a
// leaf is a `FilterCondition { field, op, value }`.
// ---------------------------------------------------------------------------

export const runtimeVaultFilterOpSchema = z.enum([
	"equals",
	"not_equals",
	"contains",
	"not_contains",
	"any_of",
	"none_of",
	"is_empty",
	"is_not_empty",
	"before",
	"after",
]);
export type RuntimeVaultFilterOp = z.infer<typeof runtimeVaultFilterOpSchema>;

export const runtimeVaultFilterConditionSchema = z.object({
	// A doc field: a built-in (`type`/`title`/`updated`/`created`) or a frontmatter key.
	field: z.string().min(1),
	op: runtimeVaultFilterOpSchema,
	// Omitted for the unary `is_empty`/`is_not_empty` ops; an array for `any_of`/`none_of`.
	value: runtimeVaultFrontmatterValueSchema.optional(),
});
export type RuntimeVaultFilterCondition = z.infer<typeof runtimeVaultFilterConditionSchema>;

export type RuntimeVaultFilterNode = RuntimeVaultFilterCondition | RuntimeVaultFilterGroup;
export type RuntimeVaultFilterGroup = { all: RuntimeVaultFilterNode[] } | { any: RuntimeVaultFilterNode[] };

// Recursive group/node schemas. `z.lazy` defers evaluation so the mutual reference
// resolves at parse time, not module-init time.
export const runtimeVaultFilterGroupSchema: z.ZodType<RuntimeVaultFilterGroup> = z.lazy(() =>
	z.union([
		z.object({ all: z.array(runtimeVaultFilterNodeSchema) }),
		z.object({ any: z.array(runtimeVaultFilterNodeSchema) }),
	]),
);
const runtimeVaultFilterNodeSchema: z.ZodType<RuntimeVaultFilterNode> = z.lazy(() =>
	z.union([runtimeVaultFilterConditionSchema, runtimeVaultFilterGroupSchema]),
);

export const runtimeVaultSortDirectionSchema = z.enum(["asc", "desc"]);
export type RuntimeVaultSortDirection = z.infer<typeof runtimeVaultSortDirectionSchema>;

export const runtimeVaultSortSchema = z.object({
	field: z.string().min(1),
	direction: runtimeVaultSortDirectionSchema,
});
export type RuntimeVaultSort = z.infer<typeof runtimeVaultSortSchema>;

export const runtimeVaultViewLayoutSchema = z.enum(["table", "board"]);
export type RuntimeVaultViewLayout = z.infer<typeof runtimeVaultViewLayoutSchema>;

export const runtimeVaultViewSchema = z.object({
	id: z.string(),
	// The document type this view applies to (e.g. "requirement").
	type: z.string(),
	name: z.string(),
	// A lucide icon name, or null for the type's default icon.
	icon: z.string().nullable().default(null),
	// Sidebar/tab ordering (lower first); ties broken by createdAt.
	order: z.number().default(0),
	layout: runtimeVaultViewLayoutSchema.default("table"),
	sort: runtimeVaultSortSchema.nullable().default(null),
	// Frontmatter keys shown as columns (besides the always-present title).
	listPropertiesDisplay: z.array(z.string()).default([]),
	filters: runtimeVaultFilterGroupSchema,
	createdAt: z.number(),
	updatedAt: z.number(),
});
export type RuntimeVaultView = z.infer<typeof runtimeVaultViewSchema>;

export const runtimeVaultViewsListRequestSchema = z.object({
	type: z.string().optional(),
});
export type RuntimeVaultViewsListRequest = z.infer<typeof runtimeVaultViewsListRequestSchema>;

export const runtimeVaultViewsListResponseSchema = z.object({
	views: z.array(runtimeVaultViewSchema),
});
export type RuntimeVaultViewsListResponse = z.infer<typeof runtimeVaultViewsListResponseSchema>;

export const runtimeVaultViewCreateRequestSchema = z.object({
	type: z.string(),
	name: z.string(),
	icon: z.string().nullable().optional(),
	order: z.number().optional(),
	layout: runtimeVaultViewLayoutSchema.optional(),
	sort: runtimeVaultSortSchema.nullable().optional(),
	listPropertiesDisplay: z.array(z.string()).optional(),
	filters: runtimeVaultFilterGroupSchema.optional(),
});
export type RuntimeVaultViewCreateRequest = z.infer<typeof runtimeVaultViewCreateRequestSchema>;

export const runtimeVaultViewCreateResponseSchema = z.object({
	view: runtimeVaultViewSchema,
});
export type RuntimeVaultViewCreateResponse = z.infer<typeof runtimeVaultViewCreateResponseSchema>;

export const runtimeVaultViewUpdateRequestSchema = z.object({
	id: z.string(),
	// Patch semantics: omitted fields are left unchanged.
	name: z.string().optional(),
	icon: z.string().nullable().optional(),
	order: z.number().optional(),
	layout: runtimeVaultViewLayoutSchema.optional(),
	sort: runtimeVaultSortSchema.nullable().optional(),
	listPropertiesDisplay: z.array(z.string()).optional(),
	filters: runtimeVaultFilterGroupSchema.optional(),
});
export type RuntimeVaultViewUpdateRequest = z.infer<typeof runtimeVaultViewUpdateRequestSchema>;

export const runtimeVaultViewUpdateResponseSchema = z.object({
	view: runtimeVaultViewSchema,
});
export type RuntimeVaultViewUpdateResponse = z.infer<typeof runtimeVaultViewUpdateResponseSchema>;

export const runtimeVaultViewDeleteRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeVaultViewDeleteRequest = z.infer<typeof runtimeVaultViewDeleteRequestSchema>;

export const runtimeVaultViewDeleteResponseSchema = z.object({
	deleted: z.boolean(),
});
export type RuntimeVaultViewDeleteResponse = z.infer<typeof runtimeVaultViewDeleteResponseSchema>;

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(z.string()),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

export const runtimeTaskSessionSummarySchema = z.object({
	taskId: z.string(),
	state: runtimeTaskSessionStateSchema,
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	/**
	 * Agent-native conversation identifier Kanban pins at launch so a session can be
	 * resumed in its original context after a restart (e.g. `claude --session-id`/`--resume`).
	 * Agent-agnostic by design; only the Claude adapter populates it today.
	 */
	agentSessionId: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeKanbanMcpServerAuthStatusSchema = z.object({
	serverName: z.string(),
	oauthSupported: z.boolean(),
	oauthConfigured: z.boolean(),
	lastError: z.string().nullable(),
	lastAuthenticatedAt: z.number().nullable(),
});
export type RuntimeKanbanMcpServerAuthStatus = z.infer<typeof runtimeKanbanMcpServerAuthStatusSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
	kanbanSessionContextVersion: z.number().int().nonnegative(),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamTaskChatMessageSchema = z.object({
	type: z.literal("task_chat_message"),
	workspaceId: z.string(),
	taskId: z.string(),
	message: z.lazy(() => runtimeTaskChatMessageSchema),
});
export type RuntimeStateStreamTaskChatMessage = z.infer<typeof runtimeStateStreamTaskChatMessageSchema>;

export const runtimeStateStreamTaskChatClearedMessageSchema = z.object({
	type: z.literal("task_chat_cleared"),
	workspaceId: z.string(),
	taskId: z.string(),
});
export type RuntimeStateStreamTaskChatClearedMessage = z.infer<typeof runtimeStateStreamTaskChatClearedMessageSchema>;

export const runtimeStateStreamMcpAuthUpdatedMessageSchema = z.object({
	type: z.literal("mcp_auth_updated"),
	statuses: z.array(runtimeKanbanMcpServerAuthStatusSchema),
});
export type RuntimeStateStreamMcpAuthUpdatedMessage = z.infer<typeof runtimeStateStreamMcpAuthUpdatedMessageSchema>;

export const runtimeStateStreamKanbanSessionContextUpdatedMessageSchema = z.object({
	type: z.literal("kanban_session_context_updated"),
	version: z.number().int().nonnegative(),
});
export type RuntimeStateStreamKanbanSessionContextUpdatedMessage = z.infer<
	typeof runtimeStateStreamKanbanSessionContextUpdatedMessageSchema
>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamTaskChatMessageSchema,
	runtimeStateStreamTaskChatClearedMessageSchema,
	runtimeStateStreamMcpAuthUpdatedMessageSchema,
	runtimeStateStreamKanbanSessionContextUpdatedMessageSchema,
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z
	.object({
		path: z.string().optional(),
		gitUrl: z.string().optional(),
		initializeGit: z.boolean().optional(),
	})
	.refine((data) => data.path || data.gitUrl, { message: "Either path or gitUrl is required" });
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeDirectoryListEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	isGitRepository: z.boolean(),
});
export type RuntimeDirectoryListEntry = z.infer<typeof runtimeDirectoryListEntrySchema>;

export const runtimeDirectoryListRequestSchema = z.object({
	path: z.string().optional(),
});
export type RuntimeDirectoryListRequest = z.infer<typeof runtimeDirectoryListRequestSchema>;

export const runtimeDirectoryListResponseSchema = z.object({
	ok: z.boolean(),
	currentPath: z.string(),
	parentPath: z.string().nullable(),
	rootPath: z.string(),
	entries: z.array(runtimeDirectoryListEntrySchema),
	error: z.string().optional(),
});
export type RuntimeDirectoryListResponse = z.infer<typeof runtimeDirectoryListResponseSchema>;

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		warning: z.string().optional(),
		error: z.string().optional(),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

// Managed OAuth providers for the Kanban-native (pi) agent's model access.
// "cline" here is the Cline-hosted account/model API (app.cline.bot / api.cline.bot),
// NOT the removed external Cline CLI agent — keep it.
export const runtimeKanbanOauthProviderSchema = z.enum(["cline", "oca", "openai-codex"]);
export type RuntimeKanbanOauthProvider = z.infer<typeof runtimeKanbanOauthProviderSchema>;

export const runtimeKanbanProviderSettingsSchema = z.object({
	providerId: z.string().nullable(),
	modelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	reasoningEffort: runtimeReasoningEffortSchema.nullable().optional(),
	apiKeyConfigured: z.boolean(),
	oauthProvider: runtimeKanbanOauthProviderSchema.nullable(),
	oauthAccessTokenConfigured: z.boolean(),
	oauthRefreshTokenConfigured: z.boolean(),
	oauthAccountId: z.string().nullable(),
	oauthExpiresAt: z.number().int().positive().nullable(),
});
export type RuntimeKanbanProviderSettings = z.infer<typeof runtimeKanbanProviderSettingsSchema>;

export const runtimeKanbanAccountProfileSchema = z.object({
	accountId: z.string().nullable(),
	email: z.string().nullable(),
	displayName: z.string().nullable(),
});
export type RuntimeKanbanAccountProfile = z.infer<typeof runtimeKanbanAccountProfileSchema>;

export const runtimeKanbanAccountProfileResponseSchema = z.object({
	profile: runtimeKanbanAccountProfileSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeKanbanAccountProfileResponse = z.infer<typeof runtimeKanbanAccountProfileResponseSchema>;

export const runtimeKanbanKanbanAccessResponseSchema = z.object({
	enabled: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeKanbanKanbanAccessResponse = z.infer<typeof runtimeKanbanKanbanAccessResponseSchema>;

export const runtimeKanbanAccountOrganizationSchema = z.object({
	organizationId: z.string(),
	name: z.string(),
	active: z.boolean(),
	roles: z.array(z.string()),
});
export type RuntimeKanbanAccountOrganization = z.infer<typeof runtimeKanbanAccountOrganizationSchema>;

export const runtimeKanbanAccountOrganizationsResponseSchema = z.object({
	organizations: z.array(runtimeKanbanAccountOrganizationSchema),
	error: z.string().optional(),
});
export type RuntimeKanbanAccountOrganizationsResponse = z.infer<typeof runtimeKanbanAccountOrganizationsResponseSchema>;

export const runtimeKanbanAccountBalanceResponseSchema = z.object({
	balance: z.number().nullable(),
	activeAccountLabel: z.string().nullable(),
	activeOrganizationId: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeKanbanAccountBalanceResponse = z.infer<typeof runtimeKanbanAccountBalanceResponseSchema>;

export const runtimeKanbanAccountSwitchRequestSchema = z.object({
	organizationId: z.string().nullable(),
});
export type RuntimeKanbanAccountSwitchRequest = z.infer<typeof runtimeKanbanAccountSwitchRequestSchema>;

export const runtimeKanbanAccountSwitchResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeKanbanAccountSwitchResponse = z.infer<typeof runtimeKanbanAccountSwitchResponseSchema>;

export const runtimeFeaturebaseTokenResponseSchema = z.object({
	featurebaseJwt: z.string(),
});
export type RuntimeFeaturebaseTokenResponse = z.infer<typeof runtimeFeaturebaseTokenResponseSchema>;

export const runtimeProviderProtocolSchema = z.enum(["anthropic", "openai"]);
export type RuntimeProviderProtocol = z.infer<typeof runtimeProviderProtocolSchema>;

export const runtimeProtocolConfigSchema = z.object({
	protocol: runtimeProviderProtocolSchema,
	baseUrl: z.string().optional(),
});
export type RuntimeProtocolConfig = z.infer<typeof runtimeProtocolConfigSchema>;

/**
 * Anthropic-protocol-specific provider settings. Only meaningful for providers
 * that speak the Anthropic protocol; namespaced rather than flattened so they
 * aren't carried as dead fields on every provider config.
 */
export const runtimeAnthropicProviderSettingsSchema = z.object({
	apiKeyField: z.enum(["auth_token", "api_key"]).optional(),
	defaultModels: z
		.object({ haiku: z.string().optional(), sonnet: z.string().optional(), opus: z.string().optional() })
		.optional(),
});
export type RuntimeAnthropicProviderSettings = z.infer<typeof runtimeAnthropicProviderSettingsSchema>;

export const runtimeKanbanProviderCatalogItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	oauthSupported: z.boolean(),
	enabled: z.boolean(),
	defaultModelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	supportsBaseUrl: z.boolean(),
	env: z.array(z.string()).optional(),
	protocols: z.array(runtimeProtocolConfigSchema).default([]),
	/** The provider's persisted model list (so edit dialogs can echo it). */
	models: z.array(z.string()).default([]),
	/** Persisted remote `/models` discovery endpoint, if any. */
	modelsSourceUrl: z.string().nullable().default(null),
	/** Persisted Anthropic-protocol settings (so edit dialogs can echo them). */
	anthropic: runtimeAnthropicProviderSettingsSchema.optional(),
	/**
	 * Non-secret, partially-masked preview of the configured API key (e.g.
	 * `sk-ab••••••wxyz`), so the edit dialog can let the user confirm *which*
	 * key is set without the full secret ever leaving the runtime. `null` when
	 * no key is configured.
	 */
	apiKeyPreview: z.string().nullable().default(null),
});
export type RuntimeKanbanProviderCatalogItem = z.infer<typeof runtimeKanbanProviderCatalogItemSchema>;

export const runtimeKanbanProviderCatalogResponseSchema = z.object({
	providers: z.array(runtimeKanbanProviderCatalogItemSchema),
});
export type RuntimeKanbanProviderCatalogResponse = z.infer<typeof runtimeKanbanProviderCatalogResponseSchema>;

export const runtimeKanbanProviderModelsRequestSchema = z.object({
	providerId: z.string(),
});
export type RuntimeKanbanProviderModelsRequest = z.infer<typeof runtimeKanbanProviderModelsRequestSchema>;

export const runtimeKanbanProviderModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	supportsVision: z.boolean().optional(),
	supportsAttachments: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
});
export type RuntimeKanbanProviderModel = z.infer<typeof runtimeKanbanProviderModelSchema>;

export const runtimeKanbanProviderModelsResponseSchema = z.object({
	providerId: z.string(),
	models: z.array(runtimeKanbanProviderModelSchema),
});
export type RuntimeKanbanProviderModelsResponse = z.infer<typeof runtimeKanbanProviderModelsResponseSchema>;

// ── Remote model fetching (by baseUrl + protocol) ─────────────────────────────
export const runtimeFetchRemoteModelsRequestSchema = z.object({
	baseUrl: z.string().url(),
	protocol: runtimeProviderProtocolSchema,
	apiKey: z.string().optional(),
});
export type RuntimeFetchRemoteModelsRequest = z.infer<typeof runtimeFetchRemoteModelsRequestSchema>;

export const runtimeFetchRemoteModelsResponseSchema = z.object({
	models: z.array(z.string()),
});
export type RuntimeFetchRemoteModelsResponse = z.infer<typeof runtimeFetchRemoteModelsResponseSchema>;

export const runtimeKanbanProviderCapabilitySchema = z.enum([
	"streaming",
	"tools",
	"reasoning",
	"vision",
	"prompt-cache",
]);
export type RuntimeKanbanProviderCapability = z.infer<typeof runtimeKanbanProviderCapabilitySchema>;

// ── Agent-level provider config ──────────────────────────────────────────────

export const runtimeAgentProviderConfigSchema = z.object({
	agentId: z.string(),
	provider: z.string().optional(),
	model: z.string().optional(),
	/** Full list of models the user configured/fetched for this provider. */
	models: z.array(z.string()).optional(),
	/** Remote `/models` discovery endpoint the model list was fetched from. */
	modelsSourceUrl: z.string().optional(),
	apiKey: z.string().optional(),
	baseUrl: z.string().optional(),
	protocols: z
		.array(
			z.object({
				protocol: z.string(),
				baseUrl: z.string().optional(),
			}),
		)
		.optional(),
	reasoning: z
		.object({
			enabled: z.boolean().optional(),
			effort: z.string().optional(),
			budgetTokens: z.number().optional(),
		})
		.optional(),
	/** Anthropic-protocol-specific settings (key header + per-tier model overrides). */
	anthropic: runtimeAnthropicProviderSettingsSchema.optional(),
	headers: z.record(z.string()).optional(),
	timeout: z.number().optional(),
	region: z.string().optional(),
	aws: z.record(z.unknown()).optional(),
	gcp: z.object({ projectId: z.string().optional(), region: z.string().optional() }).optional(),
});
export type RuntimeAgentProviderConfig = z.infer<typeof runtimeAgentProviderConfigSchema>;

export const runtimeAgentProviderConfigListResponseSchema = z.object({
	agents: z.record(z.string(), runtimeAgentProviderConfigSchema),
});
export type RuntimeAgentProviderConfigListResponse = z.infer<typeof runtimeAgentProviderConfigListResponseSchema>;

// An agent's full set of registered providers plus its default selection. A
// session can pick any registered provider (by `providerId` = provider name) at
// launch, so two sessions of the same agent can run different providers.
export const runtimeAgentProviderSetSchema = z.object({
	agentId: z.string(),
	providers: z.array(runtimeAgentProviderConfigSchema),
	defaultProviderId: z.string().optional(),
});
export type RuntimeAgentProviderSet = z.infer<typeof runtimeAgentProviderSetSchema>;

export const runtimeAgentProviderSetListResponseSchema = z.object({
	agents: z.record(z.string(), runtimeAgentProviderSetSchema),
});
export type RuntimeAgentProviderSetListResponse = z.infer<typeof runtimeAgentProviderSetListResponseSchema>;

export const runtimeAgentProviderConfigSaveRequestSchema = z.object({
	agentId: z.string(),
	config: runtimeAgentProviderConfigSchema,
});
export type RuntimeAgentProviderConfigSaveRequest = z.infer<typeof runtimeAgentProviderConfigSaveRequestSchema>;

export const runtimeAgentProviderDeleteRequestSchema = z.object({
	agentId: z.string(),
});
export type RuntimeAgentProviderDeleteRequest = z.infer<typeof runtimeAgentProviderDeleteRequestSchema>;

export const runtimeAgentProviderMutationRequestSchema = z.object({
	agentId: z.string(),
	providerId: z.string(),
});
export type RuntimeAgentProviderMutationRequest = z.infer<typeof runtimeAgentProviderMutationRequestSchema>;

export const runtimeAgentProviderMutationResponseSchema = z.object({
	ok: z.boolean(),
	config: runtimeAgentProviderConfigSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeAgentProviderMutationResponse = z.infer<typeof runtimeAgentProviderMutationResponseSchema>;

export const runtimeKanbanOauthLoginRequestSchema = z.object({
	provider: runtimeKanbanOauthProviderSchema,
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeKanbanOauthLoginRequest = z.infer<typeof runtimeKanbanOauthLoginRequestSchema>;

export const runtimeKanbanOauthLoginResponseSchema = z.object({
	ok: z.boolean(),
	provider: runtimeKanbanOauthProviderSchema,
	settings: runtimeKanbanProviderSettingsSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeKanbanOauthLoginResponse = z.infer<typeof runtimeKanbanOauthLoginResponseSchema>;

export const runtimeKanbanDeviceAuthStartResponseSchema = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUrl: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
});
export type RuntimeKanbanDeviceAuthStartResponse = z.infer<typeof runtimeKanbanDeviceAuthStartResponseSchema>;

export const runtimeKanbanDeviceAuthCompleteRequestSchema = z.object({
	deviceCode: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeKanbanDeviceAuthCompleteRequest = z.infer<typeof runtimeKanbanDeviceAuthCompleteRequestSchema>;

export const runtimeKanbanDeviceAuthCompleteResponseSchema = runtimeKanbanOauthLoginResponseSchema;
export type RuntimeKanbanDeviceAuthCompleteResponse = z.infer<typeof runtimeKanbanDeviceAuthCompleteResponseSchema>;

const runtimeKanbanMcpServerBaseSchema = z.object({
	name: z.string(),
	disabled: z.boolean(),
});

export const runtimeKanbanMcpServerSchema = z.discriminatedUnion("type", [
	runtimeKanbanMcpServerBaseSchema.extend({
		type: z.literal("stdio"),
		command: z.string(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
	runtimeKanbanMcpServerBaseSchema.extend({
		type: z.literal("sse"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	runtimeKanbanMcpServerBaseSchema.extend({
		type: z.literal("streamableHttp"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);
export type RuntimeKanbanMcpServer = z.infer<typeof runtimeKanbanMcpServerSchema>;

export const runtimeKanbanMcpSettingsResponseSchema = z.object({
	path: z.string(),
	servers: z.array(runtimeKanbanMcpServerSchema),
});
export type RuntimeKanbanMcpSettingsResponse = z.infer<typeof runtimeKanbanMcpSettingsResponseSchema>;

export const runtimeKanbanMcpSettingsSaveRequestSchema = z.object({
	servers: z.array(runtimeKanbanMcpServerSchema),
});
export type RuntimeKanbanMcpSettingsSaveRequest = z.infer<typeof runtimeKanbanMcpSettingsSaveRequestSchema>;

export const runtimeKanbanMcpSettingsSaveResponseSchema = runtimeKanbanMcpSettingsResponseSchema;
export type RuntimeKanbanMcpSettingsSaveResponse = z.infer<typeof runtimeKanbanMcpSettingsSaveResponseSchema>;

export const runtimeKanbanMcpAuthStatusResponseSchema = z.object({
	statuses: z.array(runtimeKanbanMcpServerAuthStatusSchema),
});
export type RuntimeKanbanMcpAuthStatusResponse = z.infer<typeof runtimeKanbanMcpAuthStatusResponseSchema>;

export const runtimeKanbanMcpOAuthRequestSchema = z.object({
	serverName: z.string(),
});
export type RuntimeKanbanMcpOAuthRequest = z.infer<typeof runtimeKanbanMcpOAuthRequestSchema>;

export const runtimeKanbanMcpOAuthResponseSchema = z.object({
	serverName: z.string(),
	authorized: z.literal(true),
	message: z.string(),
});
export type RuntimeKanbanMcpOAuthResponse = z.infer<typeof runtimeKanbanMcpOAuthResponseSchema>;

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeUpdateStatusResponseSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	updateTiming: z.enum(["startup", "shutdown"]).nullable(),
	installCommand: z.string().nullable(),
});
export type RuntimeUpdateStatusResponse = z.infer<typeof runtimeUpdateStatusResponseSchema>;

export const runtimeRunUpdateResponseSchema = z.object({
	status: z.enum([
		"updated",
		"already_up_to_date",
		"cache_refreshed",
		"unsupported_installation",
		"check_failed",
		"update_failed",
	]),
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	message: z.string(),
});
export type RuntimeRunUpdateResponse = z.infer<typeof runtimeRunUpdateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	kanbanProviderSettings: runtimeKanbanProviderSettingsSchema,
	commitPromptTemplate: z.string(),
	openPrPromptTemplate: z.string(),
	commitPromptTemplateDefault: z.string(),
	openPrPromptTemplateDefault: z.string(),
	proxyEnabled: z.boolean(),
	proxyHost: z.string(),
	proxyPort: z.string(),
	proxyUsername: z.string(),
	proxyPassword: z.string(),
	noProxy: z.string(),
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
	commitPromptTemplate: z.string().optional(),
	openPrPromptTemplate: z.string().optional(),
	proxyEnabled: z.boolean().optional(),
	proxyHost: z.string().optional(),
	proxyPort: z.string().optional(),
	proxyUsername: z.string().optional(),
	proxyPassword: z.string().optional(),
	noProxy: z.string().optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	/** Display title from the Kanban task card. Propagated to SDK session metadata as a convenience copy. */
	taskTitle: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeFromTrash: z.boolean().optional(),
	baseRef: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	agentId: runtimeAgentIdSchema.optional(),
	agentSettings: runtimeTaskAgentSettingsSchema.optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeTaskChatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system", "tool", "reasoning", "status"]),
	content: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	createdAt: z.number(),
	meta: z
		.object({
			toolName: z.string().nullable().optional(),
			hookEventName: z.string().nullable().optional(),
			toolCallId: z.string().nullable().optional(),
			streamType: z.string().nullable().optional(),
			messageKind: z.string().nullable().optional(),
			displayRole: z.string().nullable().optional(),
			reason: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
});
export type RuntimeTaskChatMessage = z.infer<typeof runtimeTaskChatMessageSchema>;

export const runtimeTaskChatMessagesRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatMessagesRequest = z.infer<typeof runtimeTaskChatMessagesRequestSchema>;

export const runtimeTaskChatMessagesResponseSchema = z.object({
	ok: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskChatMessagesResponse = z.infer<typeof runtimeTaskChatMessagesResponseSchema>;

export const runtimeTaskChatSendRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	/**
	 * Per-session provider override (the name of a provider already registered for
	 * the agent). Applied only when this message lazily starts the session, so it
	 * pins the launch provider for this one session without changing the agent's
	 * default or any other running session. Ignored once the session is live.
	 */
	providerId: z.string().optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

export const runtimeTaskChatSendResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

export const runtimeTaskChatReloadRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatReloadRequest = z.infer<typeof runtimeTaskChatReloadRequestSchema>;

export const runtimeTaskChatReloadResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatReloadResponse = z.infer<typeof runtimeTaskChatReloadResponseSchema>;

export const runtimeTaskChatAbortRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatAbortRequest = z.infer<typeof runtimeTaskChatAbortRequestSchema>;

export const runtimeTaskChatAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatAbortResponse = z.infer<typeof runtimeTaskChatAbortResponseSchema>;

export const runtimeTaskChatCancelRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatCancelRequest = z.infer<typeof runtimeTaskChatCancelRequestSchema>;

export const runtimeTaskChatCancelResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatCancelResponse = z.infer<typeof runtimeTaskChatCancelResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
