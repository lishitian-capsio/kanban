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

// --- Task artifacts (read-only, weak-reference) ---------------------------------
// Artifacts are "成果类" files (markdown, images, pdf, json, csv, …) a task wrote
// into its worktree, surfaced as a read-only third diff tab. There is NO registry,
// no id, no snapshot: the list is recomputed from the worktree on every read and
// holds only a relative path + a path-derived type label. When a file is renamed,
// deleted, or the worktree is cleaned up, the reference simply disappears.
export const runtimeArtifactPreviewKindSchema = z.enum(["markdown", "image", "text", "json", "binary"]);
export type RuntimeArtifactPreviewKind = z.infer<typeof runtimeArtifactPreviewKindSchema>;

export const runtimeArtifactStatusSchema = z.enum(["new", "modified"]);
export type RuntimeArtifactStatus = z.infer<typeof runtimeArtifactStatusSchema>;

export const runtimeArtifactSchema = z.object({
	path: z.string(),
	type: z.string(),
	label: z.string(),
	status: runtimeArtifactStatusSchema,
	previewKind: runtimeArtifactPreviewKindSchema,
});
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;

export const runtimeArtifactsRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeArtifactsRequest = z.infer<typeof runtimeArtifactsRequestSchema>;

export const runtimeArtifactsResponseSchema = z.object({
	artifacts: z.array(runtimeArtifactSchema),
	generatedAt: z.number(),
});
export type RuntimeArtifactsResponse = z.infer<typeof runtimeArtifactsResponseSchema>;

export const runtimeArtifactContentRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	path: z.string(),
});
export type RuntimeArtifactContentRequest = z.infer<typeof runtimeArtifactContentRequestSchema>;

export const runtimeArtifactContentResponseSchema = z.object({
	path: z.string(),
	previewKind: runtimeArtifactPreviewKindSchema,
	// Exactly one of `text` / `data` is populated for previewable content; binary
	// payloads over the size cap return both null with `truncated: true`.
	text: z.string().nullable(),
	data: z.string().nullable(),
	mimeType: z.string().nullable(),
	size: z.number(),
	truncated: z.boolean(),
});
export type RuntimeArtifactContentResponse = z.infer<typeof runtimeArtifactContentResponseSchema>;

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

export const runtimeAgentIdSchema = z.enum(["claude", "codex", "gemini", "opencode", "droid", "kiro", "qoder", "pi"]);
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

// Write the workspace repo's git identity (the real repo-local `git config
// user.name`/`user.email`, not a Kanban-only setting). Either field may be empty —
// an empty field clears that setting — but not both, matching the read-side null
// semantics. The email, when present, must look like an address.
export const runtimeSetGitUserIdentityRequestSchema = z
	.object({
		name: z.string(),
		email: z.string().refine((value) => value.trim() === "" || /^[^\s@]+@[^\s@]+$/.test(value.trim()), {
			message: "Enter a valid email address.",
		}),
	})
	.refine((value) => value.name.trim().length > 0 || value.email.trim().length > 0, {
		message: "Provide a git user name or email — at least one is required.",
	});
export type RuntimeSetGitUserIdentityRequest = z.infer<typeof runtimeSetGitUserIdentityRequestSchema>;

export const runtimeSetGitUserIdentityResponseSchema = z.object({
	identity: runtimeTaskOwnerSchema.nullable(),
});
export type RuntimeSetGitUserIdentityResponse = z.infer<typeof runtimeSetGitUserIdentityResponseSchema>;

// The workspace repo's `origin` remote URL, or null when no `origin` is configured (the
// common case for a repo Kanban `git init`-ed locally). The web-ui reads this to show and
// edit where the code repo pushes; authentication is never part of this — credentials stay
// with the system git credential helper / SSH agent.
export const runtimeGitRemoteResponseSchema = z.object({
	url: z.string().nullable(),
});
export type RuntimeGitRemoteResponse = z.infer<typeof runtimeGitRemoteResponseSchema>;

// Set the workspace repo's `origin` remote URL (the real `git remote`, not a Kanban-only
// setting). The URL must look like a git remote: a `scheme://…` URL, the scp-like
// `user@host:path` SSH form, or a local path. Kept in sync with `isLikelyGitRemoteUrl` in
// src/workspace/git-utils.ts.
export const runtimeSetGitRemoteRequestSchema = z.object({
	url: z
		.string()
		.refine((value) => /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+|[^@\s]+@[^:\s]+:\S+|[./~]\S*)$/.test(value.trim()), {
			message: "Enter a valid git remote URL.",
		}),
});
export type RuntimeSetGitRemoteRequest = z.infer<typeof runtimeSetGitRemoteRequestSchema>;

export const runtimeSetGitRemoteResponseSchema = z.object({
	url: z.string().nullable(),
});
export type RuntimeSetGitRemoteResponse = z.infer<typeof runtimeSetGitRemoteResponseSchema>;

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
// How the thread's current `name` was set. `manual` means a human typed/renamed it
// and it is PINNED — the thread's own agent must not overwrite it. `auto` means the
// title is agent-managed (a provisional title derived from the kickoff description, or
// a concise title the agent summarized via `home-thread set-title`); the agent may
// freely re-title it as the conversation's topic shifts. Existing persisted threads
// have no field and load as `manual` (their names were user-typed), so the agent never
// clobbers a pre-existing name.
export const runtimeHomeChatThreadTitleSourceSchema = z.enum(["auto", "manual"]);
export type RuntimeHomeChatThreadTitleSource = z.infer<typeof runtimeHomeChatThreadTitleSourceSchema>;

export const runtimeHomeChatThreadSchema = z.object({
	id: z.string(),
	agentId: runtimeAgentIdSchema,
	name: z.string(),
	titleSource: runtimeHomeChatThreadTitleSourceSchema.default("manual"),
	createdAt: z.number(),
	updatedAt: z.number(),
	// Transient per-thread "next step" the thread's own agent proposes at the end of a turn
	// (via `home-thread suggest-next`), surfaced in the sidebar as a clickable chip. It is a
	// ready-to-send next user message, NOT conversation history: a new suggest-next overwrites
	// it, and it is cleared when the user sends a message in the thread (the agent's next turn).
	// Optional + nullable so existing persisted threads (no field) load cleanly.
	pendingNextStep: z.string().nullable().optional(),
});
export type RuntimeHomeChatThread = z.infer<typeof runtimeHomeChatThreadSchema>;

// Persisted fullscreen-workspace UI state (decision 1902b): which session threads
// are open as tabs, and which tab is active. This is pure view state layered on the
// SAME registry doc as the threads — the session data model is untouched. The
// fullscreen Home-tab/session-tab layout reads it to restore the open tab set + active
// tab when round-tripping docked↔fullscreen. `activeThreadId === null` means the Home
// tab (launcher) is active; otherwise it is the active session tab's thread id.
export const runtimeHomeChatFullscreenTabsSchema = z.object({
	openThreadIds: z.array(z.string()).default([]),
	activeThreadId: z.string().nullable().default(null),
});
export type RuntimeHomeChatFullscreenTabs = z.infer<typeof runtimeHomeChatFullscreenTabsSchema>;

export const runtimeHomeChatThreadsDataSchema = z.object({
	threads: z.array(runtimeHomeChatThreadSchema).default([]),
	// Optional so existing `threads.json` (no field) loads cleanly as "no tabs persisted yet".
	fullscreenTabs: runtimeHomeChatFullscreenTabsSchema.optional(),
});
export type RuntimeHomeChatThreadsData = z.infer<typeof runtimeHomeChatThreadsDataSchema>;

export const runtimeHomeChatThreadsListResponseSchema = z.object({
	ok: z.boolean(),
	threads: z.array(runtimeHomeChatThreadSchema),
	// The persisted fullscreen tab set, when present. Absent on error or when never set.
	fullscreenTabs: runtimeHomeChatFullscreenTabsSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeHomeChatThreadsListResponse = z.infer<typeof runtimeHomeChatThreadsListResponseSchema>;

export const runtimeHomeChatThreadCreateRequestSchema = z.object({
	// A free-text description of what the thread is for. When present it becomes the
	// thread's kickoff prompt (the agent's first message) and the seed for a provisional
	// `auto` title; the thread's own agent then summarizes a concise title shortly after
	// its first turn. Preferred over `name` for new threads.
	description: z.string().optional(),
	// Legacy: an explicit human title. When supplied (and no `description`), the thread is
	// created with a PINNED `manual` title and no session is started. Retained so existing
	// callers keep working; at least one of `description` / `name` must be present.
	name: z.string().optional(),
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

// An agent-driven title set (`home-thread set-title`). Distinct from rename: it writes
// `titleSource="auto"` and is SKIPPED when the thread's title is already pinned `manual`.
export const runtimeHomeChatThreadSetTitleRequestSchema = z.object({
	id: z.string(),
	title: z.string(),
});
export type RuntimeHomeChatThreadSetTitleRequest = z.infer<typeof runtimeHomeChatThreadSetTitleRequestSchema>;

// An agent-driven next-step suggestion (`home-thread suggest-next`). Like set-title it is set
// by the thread's OWN agent and skipped for the synthetic default thread, but it writes the
// transient `pendingNextStep` rather than the title.
export const runtimeHomeChatThreadSetNextStepRequestSchema = z.object({
	id: z.string(),
	suggestion: z.string(),
});
export type RuntimeHomeChatThreadSetNextStepRequest = z.infer<typeof runtimeHomeChatThreadSetNextStepRequestSchema>;

// Shared by create/rename/close — each returns the affected thread (close → the removed thread).
export const runtimeHomeChatThreadMutationResponseSchema = z.object({
	ok: z.boolean(),
	thread: runtimeHomeChatThreadSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeHomeChatThreadMutationResponse = z.infer<typeof runtimeHomeChatThreadMutationResponseSchema>;

// Persist the fullscreen-workspace tab set (open tabs + active tab). Frontend-driven
// UI state, so the request IS the new {@link RuntimeHomeChatFullscreenTabs}; the runtime
// sanitizes it (drops tabs for threads that no longer exist) before writing.
export const runtimeHomeChatFullscreenTabsSaveRequestSchema = runtimeHomeChatFullscreenTabsSchema;
export type RuntimeHomeChatFullscreenTabsSaveRequest = z.infer<
	typeof runtimeHomeChatFullscreenTabsSaveRequestSchema
>;

export const runtimeHomeChatFullscreenTabsResponseSchema = z.object({
	ok: z.boolean(),
	fullscreenTabs: runtimeHomeChatFullscreenTabsSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeHomeChatFullscreenTabsResponse = z.infer<typeof runtimeHomeChatFullscreenTabsResponseSchema>;

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
// Database (human-side browser/editor)
//
// The wire contract for the Database view. Connection metadata is secret-free
// (the password lives only in machine-home credentials, surfaced as `hasCredential`).
// The frontend never writes SQL: it sends structured browse/edit intents and the
// runtime builds the parameterized SQL (server-side LIMIT bound + policy chokepoint).
// Cell values cross the wire as display strings (or null) and edits return the same way.
// ---------------------------------------------------------------------------

export const runtimeDbEngineSchema = z.enum(["postgres", "mysql", "sqlite"]);
export type RuntimeDbEngine = z.infer<typeof runtimeDbEngineSchema>;

export const runtimeDbSslConfigSchema = z.object({
	mode: z.enum(["disable", "require", "verify-ca", "verify-full"]),
	caPath: z.string().optional(),
});
export type RuntimeDbSslConfig = z.infer<typeof runtimeDbSslConfigSchema>;

export const runtimeDbConnectionSchema = z.object({
	connId: z.string(),
	label: z.string(),
	engine: runtimeDbEngineSchema,
	host: z.string().nullable(),
	port: z.number().int().positive().nullable(),
	database: z.string().nullable(),
	user: z.string().nullable(),
	filePath: z.string().nullable(),
	ssl: runtimeDbSslConfigSchema.nullable(),
	allowWrites: z.boolean(),
	createdAt: z.string(),
	/** Whether a machine-home credential (password) is configured for this connection. */
	hasCredential: z.boolean(),
});
export type RuntimeDbConnection = z.infer<typeof runtimeDbConnectionSchema>;

export const runtimeDbConnectionsListResponseSchema = z.object({
	connections: z.array(runtimeDbConnectionSchema),
});
export type RuntimeDbConnectionsListResponse = z.infer<typeof runtimeDbConnectionsListResponseSchema>;

/**
 * Create (no `connId`) or edit (with `connId`) a connection. `password`: a string sets it,
 * `null` clears it, omitted leaves the stored secret unchanged (edit without re-typing).
 */
export const runtimeDbUpsertConnectionRequestSchema = z.object({
	connId: z.string().optional(),
	label: z.string().min(1),
	engine: runtimeDbEngineSchema,
	host: z.string().nullable().optional(),
	port: z.number().int().positive().nullable().optional(),
	database: z.string().nullable().optional(),
	user: z.string().nullable().optional(),
	filePath: z.string().nullable().optional(),
	ssl: runtimeDbSslConfigSchema.nullable().optional(),
	allowWrites: z.boolean(),
	password: z.string().nullable().optional(),
});
export type RuntimeDbUpsertConnectionRequest = z.infer<typeof runtimeDbUpsertConnectionRequestSchema>;

export const runtimeDbUpsertConnectionResponseSchema = z.object({
	connection: runtimeDbConnectionSchema,
});
export type RuntimeDbUpsertConnectionResponse = z.infer<typeof runtimeDbUpsertConnectionResponseSchema>;

export const runtimeDbDeleteConnectionRequestSchema = z.object({
	connId: z.string(),
});
export type RuntimeDbDeleteConnectionRequest = z.infer<typeof runtimeDbDeleteConnectionRequestSchema>;

export const runtimeDbDeleteConnectionResponseSchema = z.object({
	deleted: z.boolean(),
});
export type RuntimeDbDeleteConnectionResponse = z.infer<typeof runtimeDbDeleteConnectionResponseSchema>;

/**
 * Test connectivity. With a `connId` and no `password`, the stored credential is used (re-test
 * a saved connection); otherwise the supplied draft config is tested without persisting.
 */
export const runtimeDbTestConnectionRequestSchema = z.object({
	connId: z.string().optional(),
	engine: runtimeDbEngineSchema,
	host: z.string().nullable().optional(),
	port: z.number().int().positive().nullable().optional(),
	database: z.string().nullable().optional(),
	user: z.string().nullable().optional(),
	filePath: z.string().nullable().optional(),
	ssl: runtimeDbSslConfigSchema.nullable().optional(),
	password: z.string().nullable().optional(),
});
export type RuntimeDbTestConnectionRequest = z.infer<typeof runtimeDbTestConnectionRequestSchema>;

export const runtimeDbTestConnectionResponseSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number().nullable(),
	serverVersion: z.string().nullable(),
	error: z.string().nullable(),
});
export type RuntimeDbTestConnectionResponse = z.infer<typeof runtimeDbTestConnectionResponseSchema>;

export const runtimeDbColumnSchema = z.object({
	name: z.string(),
	dataType: z.string(),
	nullable: z.boolean(),
	isPrimaryKey: z.boolean(),
	defaultValue: z.string().nullable(),
});
export type RuntimeDbColumn = z.infer<typeof runtimeDbColumnSchema>;

export const runtimeDbTableSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: z.enum(["table", "view"]),
	columns: z.array(runtimeDbColumnSchema),
});
export type RuntimeDbTable = z.infer<typeof runtimeDbTableSchema>;

export const runtimeDbIntrospectRequestSchema = z.object({
	connId: z.string(),
});
export type RuntimeDbIntrospectRequest = z.infer<typeof runtimeDbIntrospectRequestSchema>;

export const runtimeDbIntrospectResponseSchema = z.object({
	engine: runtimeDbEngineSchema,
	tables: z.array(runtimeDbTableSchema),
});
export type RuntimeDbIntrospectResponse = z.infer<typeof runtimeDbIntrospectResponseSchema>;

export const runtimeDbFilterOpSchema = z.enum([
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
	"contains",
	"starts_with",
	"ends_with",
	"is_null",
	"is_not_null",
]);
export type RuntimeDbFilterOp = z.infer<typeof runtimeDbFilterOpSchema>;

export const runtimeDbFilterSchema = z.object({
	column: z.string(),
	op: runtimeDbFilterOpSchema,
	value: z.string().nullable().optional(),
});
export type RuntimeDbFilter = z.infer<typeof runtimeDbFilterSchema>;

export const runtimeDbSortSchema = z.object({
	column: z.string(),
	direction: z.enum(["asc", "desc"]),
});
export type RuntimeDbSort = z.infer<typeof runtimeDbSortSchema>;

export const runtimeDbBrowseTableRequestSchema = z.object({
	connId: z.string(),
	schema: z.string(),
	table: z.string(),
	filters: z.array(runtimeDbFilterSchema).optional(),
	sort: z.array(runtimeDbSortSchema).optional(),
	cursor: z.string().nullable().optional(),
	pageSize: z.number().int().positive().optional(),
});
export type RuntimeDbBrowseTableRequest = z.infer<typeof runtimeDbBrowseTableRequestSchema>;

/** A single result cell as a display string, or null for SQL NULL. */
export const runtimeDbCellSchema = z.string().nullable();
/** A row keyed by column name (single-table SELECT * ⇒ unique names). */
export const runtimeDbRowSchema = z.record(z.string(), runtimeDbCellSchema);
export type RuntimeDbRow = z.infer<typeof runtimeDbRowSchema>;

export const runtimeDbResultColumnSchema = z.object({
	name: z.string(),
	dataType: z.string().nullable(),
});
export type RuntimeDbResultColumn = z.infer<typeof runtimeDbResultColumnSchema>;

export const runtimeDbBrowseTableResponseSchema = z.object({
	columns: z.array(runtimeDbResultColumnSchema),
	rows: z.array(runtimeDbRowSchema),
	rowCount: z.number().int().nonnegative(),
	pagination: z.object({
		pageSize: z.number().int().positive(),
		hasMore: z.boolean(),
		nextCursor: z.string().nullable(),
	}),
	truncated: z.object({
		byRows: z.boolean(),
		byBytes: z.boolean(),
	}),
});
export type RuntimeDbBrowseTableResponse = z.infer<typeof runtimeDbBrowseTableResponseSchema>;

export const runtimeDbColumnValueSchema = z.object({
	column: z.string(),
	value: z.string().nullable(),
});
export type RuntimeDbColumnValue = z.infer<typeof runtimeDbColumnValueSchema>;

export const runtimeDbUpdateRowRequestSchema = z.object({
	connId: z.string(),
	schema: z.string(),
	table: z.string(),
	assignments: z.array(runtimeDbColumnValueSchema).min(1),
	/** Row-identifying key (introspected primary key). */
	where: z.array(runtimeDbColumnValueSchema).min(1),
});
export type RuntimeDbUpdateRowRequest = z.infer<typeof runtimeDbUpdateRowRequestSchema>;

export const runtimeDbInsertRowRequestSchema = z.object({
	connId: z.string(),
	schema: z.string(),
	table: z.string(),
	values: z.array(runtimeDbColumnValueSchema).min(1),
});
export type RuntimeDbInsertRowRequest = z.infer<typeof runtimeDbInsertRowRequestSchema>;

export const runtimeDbDeleteRowRequestSchema = z.object({
	connId: z.string(),
	schema: z.string(),
	table: z.string(),
	/** Row-identifying key (introspected primary key). */
	where: z.array(runtimeDbColumnValueSchema).min(1),
});
export type RuntimeDbDeleteRowRequest = z.infer<typeof runtimeDbDeleteRowRequestSchema>;

export const runtimeDbWriteResponseSchema = z.object({
	affectedRows: z.number().nullable(),
});
export type RuntimeDbWriteResponse = z.infer<typeof runtimeDbWriteResponseSchema>;

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

// Single-document export: the raw on-disk markdown for download. `document` is
// null when the id is unknown (e.g. deleted between list and click).
export const runtimeVaultDocumentExportRequestSchema = z.object({
	id: z.string(),
});
export type RuntimeVaultDocumentExportRequest = z.infer<typeof runtimeVaultDocumentExportRequestSchema>;

export const runtimeVaultDocumentExportResponseSchema = z.object({
	document: z
		.object({
			// Suggested download filename, the on-disk `<slug>-<id>.md`.
			fileName: z.string(),
			// Byte-exact markdown content (YAML frontmatter + body), as git tracks it.
			content: z.string(),
		})
		.nullable(),
});
export type RuntimeVaultDocumentExportResponse = z.infer<typeof runtimeVaultDocumentExportResponseSchema>;

// Multi-document export: a base64-encoded zip whose entries mirror the on-disk
// tree (`docs/<type>/<slug>-<id>.md`). Unknown ids are dropped, so `documentCount`
// reports how many were actually packed.
export const runtimeVaultArchiveExportRequestSchema = z.object({
	ids: z.array(z.string()),
});
export type RuntimeVaultArchiveExportRequest = z.infer<typeof runtimeVaultArchiveExportRequestSchema>;

export const runtimeVaultArchiveExportResponseSchema = z.object({
	// Base64-encoded zip archive, ridden over the same byte channel as file blobs.
	data: z.string(),
	documentCount: z.number(),
});
export type RuntimeVaultArchiveExportResponse = z.infer<typeof runtimeVaultArchiveExportResponseSchema>;

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
// Workspace-level vault preferences. `vaultMode` is the vault-takeover switch, a
// strictly progressive four-tier enum where each tier is a superset of the one
// before it. It governs how much vault guidance is injected into the sidebar
// agent's system prompt:
//   - `off`        (the default): nothing — no vault intro, type index, vault CLI
//                  reference, or proactive directive is injected at all.
//   - `cli-only`   : the "knowledge vault documents" intro + the vault CLI command
//                  reference, but NOT the per-workspace document-type index.
//   - `on-demand`  : everything in `cli-only` plus the document-type index.
//   - `managed`    : everything in `on-demand` plus the proactive-management
//                  directive that authorizes the agent to create/maintain vault
//                  documents on its own initiative.
// The setting is repo-scoped and committed alongside the docs (`<repo>/.kanban/
// files/settings.json`), so it travels with the vault.
// ---------------------------------------------------------------------------

export const runtimeVaultModeSchema = z.enum(["off", "cli-only", "on-demand", "managed"]);
export type RuntimeVaultMode = z.infer<typeof runtimeVaultModeSchema>;

export const runtimeVaultSettingsSchema = z.object({
	vaultMode: runtimeVaultModeSchema.default("off"),
});
export type RuntimeVaultSettings = z.infer<typeof runtimeVaultSettingsSchema>;

export const runtimeVaultSettingsGetResponseSchema = z.object({
	settings: runtimeVaultSettingsSchema,
});
export type RuntimeVaultSettingsGetResponse = z.infer<typeof runtimeVaultSettingsGetResponseSchema>;

export const runtimeVaultSettingsUpdateRequestSchema = z.object({
	vaultMode: runtimeVaultModeSchema,
});
export type RuntimeVaultSettingsUpdateRequest = z.infer<typeof runtimeVaultSettingsUpdateRequestSchema>;

export const runtimeVaultSettingsUpdateResponseSchema = z.object({
	settings: runtimeVaultSettingsSchema,
});
export type RuntimeVaultSettingsUpdateResponse = z.infer<typeof runtimeVaultSettingsUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// Board-branch sync status & settings
//
// The board's committed data lives on a dedicated, never-merged git branch
// (default `kanban/board`) read/written in a private worktree — see
// `.plan/docs/board-branch-decoupling.md`. This block is the wire surface for
// P4: the top-bar sync badge reads `RuntimeBoardSyncStatus`; manual push/pull,
// the pause-auto-sync toggle, and the (rename-migrating) branch setting are the
// mutations. `branch` is sourced from the authoritative `.kanban/board-ref`.
// ---------------------------------------------------------------------------

export const runtimeBoardSyncStateSchema = z.enum([
	// Board-branch decoupling is not active for this repo (no `board-ref`).
	"disabled",
	// Decoupled but no git remote is configured; the branch is local-only (still durable in .git).
	"local-only",
	// Worktree HEAD matches the remote tip — nothing to push or pull.
	"synced",
	// Local commits are ahead of the remote, waiting on the next (debounced) push.
	"ahead",
	// The remote moved ahead; a pull / fast-forward is pending.
	"behind",
	// Both sides advanced — a pull + merge is needed to reconcile.
	"diverged",
	// A sync (commit/push/pull) is currently running.
	"syncing",
	// A push hit a content conflict; local data is intact, awaiting manual resolution.
	"conflict",
	// The last sync failed for another reason (e.g. offline); it retries on the next sync.
	"error",
]);
export type RuntimeBoardSyncState = z.infer<typeof runtimeBoardSyncStateSchema>;

export const runtimeBoardSyncStatusSchema = z.object({
	state: runtimeBoardSyncStateSchema,
	/** Whether board-branch decoupling is active for this workspace. */
	decoupled: z.boolean(),
	/** The board branch holding the committed data, or null when decoupling is inactive. */
	branch: z.string().nullable(),
	/** Whether a git remote is configured (board data is publishable). */
	hasRemote: z.boolean(),
	/** Local commits ahead of the last-known remote tip. */
	aheadCount: z.number().int().nonnegative(),
	/** Remote commits the local worktree is behind by (since the last fetch). */
	behindCount: z.number().int().nonnegative(),
	/** Whether the debounced auto-sync is paused for this session. */
	autoSyncPaused: z.boolean(),
	/** A short message describing the last conflict/error, when relevant. */
	lastError: z.string().nullable(),
	/**
	 * Absolute path to the board worktree on disk, or null when decoupling is inactive.
	 * Surfaced so the conflict-resolution UI can point the user at where to resolve a
	 * surfaced merge conflict manually (the worktree is runtime-exclusive).
	 */
	worktreePath: z.string().nullable(),
});
export type RuntimeBoardSyncStatus = z.infer<typeof runtimeBoardSyncStatusSchema>;

export const runtimeBoardSyncStatusResponseSchema = z.object({
	status: runtimeBoardSyncStatusSchema,
});
export type RuntimeBoardSyncStatusResponse = z.infer<typeof runtimeBoardSyncStatusResponseSchema>;

export const runtimeBoardSyncActionSchema = z.enum(["push", "pull"]);
export type RuntimeBoardSyncAction = z.infer<typeof runtimeBoardSyncActionSchema>;

export const runtimeBoardSyncActionRequestSchema = z.object({
	action: runtimeBoardSyncActionSchema,
});
export type RuntimeBoardSyncActionRequest = z.infer<typeof runtimeBoardSyncActionRequestSchema>;

export const runtimeBoardSyncActionResponseSchema = z.object({
	ok: z.boolean(),
	status: runtimeBoardSyncStatusSchema,
	error: z.string().optional(),
});
export type RuntimeBoardSyncActionResponse = z.infer<typeof runtimeBoardSyncActionResponseSchema>;

/**
 * GitHub OAuth git-auth contract. Machine-global (no workspace scope). The access token is
 * NEVER carried over the wire — only the secret-free status and the device-flow handshake.
 */
export const runtimeGithubAuthStatusSchema = z.object({
	authenticated: z.boolean(),
	login: z.string().nullable(),
	scope: z.string().nullable(),
	/** Epoch ms of token expiry, or null when long-lived / not logged in. */
	expiresAt: z.number().int().positive().nullable(),
});
export type RuntimeGithubAuthStatus = z.infer<typeof runtimeGithubAuthStatusSchema>;

/**
 * The user-facing view of an in-flight device-flow login. The `deviceCode` is deliberately
 * NOT here: it stays server-side so the UI polls a server-held pending login (by no argument)
 * and a page refresh / brief disconnect can't orphan the flow. `expiresAt` is an absolute
 * epoch-ms anchor (the runtime's clock) so a resuming UI shows the correct remaining time.
 */
export const runtimeGithubLoginPromptSchema = z.object({
	userCode: z.string(),
	verificationUri: z.string(),
	intervalSeconds: z.number().int().nonnegative(),
	expiresAt: z.number().int().positive(),
});
export type RuntimeGithubLoginPrompt = z.infer<typeof runtimeGithubLoginPromptSchema>;

/** Device-flow handshake returned by `github.beginLogin` (the prompt; no `deviceCode`). */
export const runtimeGithubBeginLoginResponseSchema = runtimeGithubLoginPromptSchema;
export type RuntimeGithubBeginLoginResponse = z.infer<typeof runtimeGithubBeginLoginResponseSchema>;

/**
 * `github.pendingLogin` — the in-flight login a UI can resume after a refresh, or `null` when
 * none is active (none started, expired, or already completed/cancelled).
 */
export const runtimeGithubPendingLoginResponseSchema = z.object({
	pending: runtimeGithubLoginPromptSchema.nullable(),
});
export type RuntimeGithubPendingLoginResponse = z.infer<typeof runtimeGithubPendingLoginResponseSchema>;

export const runtimeGithubPollLoginResponseSchema = z.discriminatedUnion("state", [
	z.object({ state: z.literal("pending") }),
	z.object({ state: z.literal("complete"), status: runtimeGithubAuthStatusSchema }),
	z.object({ state: z.literal("error"), message: z.string() }),
	// No pending login server-side — the UI should drop back to its idle state.
	z.object({ state: z.literal("idle") }),
]);
export type RuntimeGithubPollLoginResponse = z.infer<typeof runtimeGithubPollLoginResponseSchema>;

export const runtimeGithubLogoutResponseSchema = z.object({
	status: runtimeGithubAuthStatusSchema,
});
export type RuntimeGithubLogoutResponse = z.infer<typeof runtimeGithubLogoutResponseSchema>;

/**
 * Gitee git-auth contract. Machine-global (no workspace scope). The PAT is NEVER carried over
 * the wire — only the secret-free status crosses it. Gitee has no OAuth device flow (decision
 * cf0d6), so this is a pasted-PAT surface (status / setToken / logout) with no begin/poll login.
 */
export const runtimeGiteeAuthStatusSchema = z.object({
	authenticated: z.boolean(),
	/** Gitee account login resolved from the API, or null when not resolved / logged out. */
	login: z.string().nullable(),
	/** The basic-auth username captured at login (may equal `login`), or null when logged out. */
	username: z.string().nullable(),
});
export type RuntimeGiteeAuthStatus = z.infer<typeof runtimeGiteeAuthStatusSchema>;

/** `gitee.setToken` input: a pasted PAT plus an optional account username. */
export const runtimeGiteeSetTokenRequestSchema = z.object({
	token: z.string().min(1),
	username: z.string().optional(),
});
export type RuntimeGiteeSetTokenRequest = z.infer<typeof runtimeGiteeSetTokenRequestSchema>;

export const runtimeGiteeSetTokenResponseSchema = z.object({
	status: runtimeGiteeAuthStatusSchema,
});
export type RuntimeGiteeSetTokenResponse = z.infer<typeof runtimeGiteeSetTokenResponseSchema>;

export const runtimeGiteeLogoutResponseSchema = z.object({
	status: runtimeGiteeAuthStatusSchema,
});
export type RuntimeGiteeLogoutResponse = z.infer<typeof runtimeGiteeLogoutResponseSchema>;

/**
 * Secret-free status of the machine-local speech-to-text (STT) config used by the
 * chat composer's voice input. The API key never crosses the wire — only a masked
 * preview and a `hasApiKey` flag, mirroring the saved-provider status convention.
 */
export const runtimeSttStatusSchema = z.object({
	/** True once a usable endpoint (base URL + model) is configured. */
	configured: z.boolean(),
	/** OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`), or null when unset. */
	baseUrl: z.string().nullable(),
	/** STT model id (e.g. `whisper-1`), or null when unset. */
	model: z.string().nullable(),
	/** Default recognition language (BCP-47 / ISO-639-1, e.g. `zh`), or null when unset. */
	language: z.string().nullable(),
	/** Whether an API key is stored (self-hosted endpoints may need none). */
	hasApiKey: z.boolean(),
	/** Non-secret, partially-masked preview of the stored API key, or null when unset. */
	apiKeyPreview: z.string().nullable(),
});
export type RuntimeSttStatus = z.infer<typeof runtimeSttStatusSchema>;

/**
 * `stt.save` input. A field left undefined is preserved from the existing config;
 * `apiKey` left undefined keeps the stored key (so the model can be changed without
 * re-entering the secret), while an empty string clears it.
 */
export const runtimeSttSaveRequestSchema = z.object({
	baseUrl: z.string().min(1),
	model: z.string().min(1).optional(),
	language: z.string().optional(),
	apiKey: z.string().optional(),
});
export type RuntimeSttSaveRequest = z.infer<typeof runtimeSttSaveRequestSchema>;

/** `stt.transcribe` input: a single recorded clip uploaded as base64. */
export const runtimeSttTranscribeRequestSchema = z.object({
	/** Base64-encoded audio bytes (e.g. webm/opus from MediaRecorder). */
	audioData: z.string().min(1),
	/** MIME type of the recording (e.g. `audio/webm`). */
	mime: z.string().min(1),
	/** Optional per-request language override; falls back to the configured default. */
	language: z.string().optional(),
});
export type RuntimeSttTranscribeRequest = z.infer<typeof runtimeSttTranscribeRequestSchema>;

export const runtimeSttTranscribeResponseSchema = z.object({
	/** The recognized transcript text (may be empty if nothing was recognized). */
	text: z.string(),
});
export type RuntimeSttTranscribeResponse = z.infer<typeof runtimeSttTranscribeResponseSchema>;

export const runtimeBoardAutoSyncRequestSchema = z.object({
	paused: z.boolean(),
});
export type RuntimeBoardAutoSyncRequest = z.infer<typeof runtimeBoardAutoSyncRequestSchema>;

export const runtimeBoardAutoSyncResponseSchema = z.object({
	status: runtimeBoardSyncStatusSchema,
});
export type RuntimeBoardAutoSyncResponse = z.infer<typeof runtimeBoardAutoSyncResponseSchema>;

export const runtimeBoardBranchUpdateRequestSchema = z.object({
	branch: z.string().min(1),
});
export type RuntimeBoardBranchUpdateRequest = z.infer<typeof runtimeBoardBranchUpdateRequestSchema>;

export const runtimeBoardBranchUpdateResponseSchema = z.object({
	ok: z.boolean(),
	status: runtimeBoardSyncStatusSchema,
	/** The archive tag left as a rollback anchor for the old branch, when one was created. */
	archivedTag: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeBoardBranchUpdateResponse = z.infer<typeof runtimeBoardBranchUpdateResponseSchema>;

// ---------------------------------------------------------------------------
// Runtime ops metrics
//
// Process-global health metrics for the VSCode-style status bar at the bottom of
// the Kanban-agent sidebar: resident memory, CPU% of the runtime process, and the
// event-loop stall state (derived from the in-process stall watchdog). These are
// NOT workspace-scoped — they describe the single runtime process — so the
// `runtime_metrics_updated` broadcast carries no workspaceId and fans out to every
// connected client. Sampled on a modest interval (~2.5s) so the channel stays low-
// frequency, like the board-sync badge.
// ---------------------------------------------------------------------------

export const runtimeOpsMetricsSchema = z.object({
	/** Resident set size of the runtime process, in bytes. */
	rssBytes: z.number().nonnegative(),
	/**
	 * CPU usage of the runtime process over the last sampling interval, as a
	 * percentage. Can exceed 100 on multi-core machines (it sums user+system time
	 * across cores), so the bar formats it but does not clamp.
	 */
	cpuPercent: z.number().nonnegative(),
	/** Whether the main event loop is currently stalled, per the stall watchdog. */
	eventLoopStalled: z.boolean(),
	/** Wall-clock time the sample was taken (epoch ms), for the tooltip detail. */
	sampledAtMs: z.number().nonnegative(),
});
export type RuntimeOpsMetrics = z.infer<typeof runtimeOpsMetricsSchema>;

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

/**
 * Cumulative token usage for a session, summed across the session's turns. Only
 * agents that surface per-run telemetry (pi) populate this; CLI/terminal agents
 * have no token accounting and leave it null. Non-sensitive — no keys/cost.
 */
export const runtimeTaskSessionUsageSchema = z.object({
	inputTokens: z.number().nonnegative(),
	outputTokens: z.number().nonnegative(),
	totalTokens: z.number().nonnegative(),
});
export type RuntimeTaskSessionUsage = z.infer<typeof runtimeTaskSessionUsageSchema>;

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
	/**
	 * Provider selected for this session (provider name == providerId) and the
	 * resolved model id actually used. Non-sensitive (no API key/base URL). Both
	 * are populated at launch by pi and CLI agents; null when unknown.
	 */
	providerId: z.string().nullable().optional(),
	modelId: z.string().nullable().optional(),
	/** Cumulative token usage; null when the agent has no token telemetry (CLI). */
	usage: runtimeTaskSessionUsageSchema.nullable().optional(),
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

export const runtimeStateStreamBoardSyncStatusMessageSchema = z.object({
	type: z.literal("board_sync_status_updated"),
	workspaceId: z.string(),
	status: runtimeBoardSyncStatusSchema,
});
export type RuntimeStateStreamBoardSyncStatusMessage = z.infer<typeof runtimeStateStreamBoardSyncStatusMessageSchema>;

export const runtimeStateStreamOpsMetricsMessageSchema = z.object({
	type: z.literal("runtime_metrics_updated"),
	metrics: runtimeOpsMetricsSchema,
});
export type RuntimeStateStreamOpsMetricsMessage = z.infer<typeof runtimeStateStreamOpsMetricsMessageSchema>;

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
	runtimeStateStreamBoardSyncStatusMessageSchema,
	runtimeStateStreamOpsMetricsMessageSchema,
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
// The Cline-hosted managed provider ("cline") and its account/credits/device-auth
// machinery were removed; the remaining values are retained as a generic, nullable
// `oauthProvider` field marker (no live login path in the omp runtime).
export const runtimeKanbanOauthProviderSchema = z.enum(["oca", "openai-codex"]);
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
	/** Inject CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 for gateway/relay model discovery (opt-in). */
	enableGatewayModelDiscovery: z.boolean().optional(),
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
	 * `sk-ab…wxyz`), so the edit dialog can let the user confirm *which*
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
	/**
	 * Non-secret, partially-masked preview of the configured API key (e.g.
	 * `sk-ab…wxyz`), attached on the redacted wire response so an edit form can
	 * show *which* key is set without the real secret ever leaving the runtime.
	 * `null` when no key is configured. Never persisted — stripped before write.
	 */
	apiKeyPreview: z.string().nullable().optional(),
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
	/**
	 * Optional absolute path to the agent's executable. When set, Kanban uses it
	 * for both detection and launch instead of discovering the catalog binary on
	 * `$PATH` — the fix for daemons whose `$PATH` omits user-local install dirs.
	 * Machine-local; empty/unset preserves `$PATH`-discovery behavior.
	 */
	executablePath: z.string().optional(),
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

// Set (or clear, with an empty string) an agent's absolute executable-path override.
export const runtimeAgentExecutablePathSaveRequestSchema = z.object({
	agentId: z.string(),
	executablePath: z.string(),
});
export type RuntimeAgentExecutablePathSaveRequest = z.infer<typeof runtimeAgentExecutablePathSaveRequestSchema>;

export const runtimeAgentExecutablePathResponseSchema = z.object({
	ok: z.boolean(),
	agentId: z.string(),
	/** The persisted override after the mutation; `null` when cleared. */
	executablePath: z.string().nullable(),
	/**
	 * Whether the effective binary (the override when set, else the catalog binary
	 * discovered on `$PATH`) is currently executable. Drives the inline
	 * "not found / not executable" hint in Settings.
	 */
	available: z.boolean(),
});
export type RuntimeAgentExecutablePathResponse = z.infer<typeof runtimeAgentExecutablePathResponseSchema>;

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
			// Set when an oversized message's content was truncated for transport
			// (see session-message-display-cap.ts). `originalContentLength` is the
			// pre-truncation character count, so a surface can show how much was elided.
			contentTruncated: z.boolean().nullable().optional(),
			originalContentLength: z.number().nullable().optional(),
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

// --- Database -----------------------------------------------------------------
// Wire contract for the `kanban db` CLI surface. Mirrors the secret-free shapes the DB
// core (src/db) exposes; secrets (password/key/cert) only ever travel inbound on `add`
// and are never returned. Kept self-contained here (api-contract imports only core) so
// the web-ui bundle never pulls in the driver modules.

export const runtimeDbConnectionListResponseSchema = z.object({
	connections: z.array(runtimeDbConnectionSchema),
});
export type RuntimeDbConnectionListResponse = z.infer<typeof runtimeDbConnectionListResponseSchema>;

export const runtimeDbConnectionAddRequestSchema = z.object({
	/** Optional explicit id; defaults to a slug of the label. Normalized (trim + lowercase). */
	connId: z.string().optional(),
	label: z.string().min(1),
	engine: runtimeDbEngineSchema,
	host: z.string().nullable().optional(),
	port: z.number().int().positive().nullable().optional(),
	database: z.string().nullable().optional(),
	user: z.string().nullable().optional(),
	filePath: z.string().nullable().optional(),
	ssl: runtimeDbSslConfigSchema.nullable().optional(),
	allowWrites: z.boolean().optional(),
	/** Secret material — stored ONLY in machine-home credentials, never committed/returned. */
	password: z.string().optional(),
	sslKeyPem: z.string().optional(),
	sslCertPem: z.string().optional(),
});
export type RuntimeDbConnectionAddRequest = z.infer<typeof runtimeDbConnectionAddRequestSchema>;

export const runtimeDbConnectionAddResponseSchema = z.object({
	connection: runtimeDbConnectionSchema,
});
export type RuntimeDbConnectionAddResponse = z.infer<typeof runtimeDbConnectionAddResponseSchema>;

export const runtimeDbConnectionRemoveRequestSchema = z.object({
	connId: z.string().min(1),
});
export type RuntimeDbConnectionRemoveRequest = z.infer<typeof runtimeDbConnectionRemoveRequestSchema>;

export const runtimeDbConnectionRemoveResponseSchema = z.object({
	connId: z.string(),
	removed: z.boolean(),
});
export type RuntimeDbConnectionRemoveResponse = z.infer<typeof runtimeDbConnectionRemoveResponseSchema>;

export const runtimeDbConnectionTestRequestSchema = z.object({
	connId: z.string().min(1),
});
export type RuntimeDbConnectionTestRequest = z.infer<typeof runtimeDbConnectionTestRequestSchema>;

export const runtimeDbConnectionTestResponseSchema = z.object({
	connId: z.string(),
	reachable: z.boolean(),
	latencyMs: z.number().nullable(),
	serverVersion: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeDbConnectionTestResponse = z.infer<typeof runtimeDbConnectionTestResponseSchema>;

export const runtimeDbTableSummarySchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: z.enum(["table", "view"]),
	/**
	 * Column count, when cheaply known. Omitted by the lazy listing path (which reads table
	 * names only): materializing every column of every table to count them is exactly the
	 * cost the lazy introspection exists to avoid on a large catalog. Expand a table
	 * (`db.describe`) to get its columns.
	 */
	columnCount: z.number().int().nonnegative().optional(),
});
export type RuntimeDbTableSummary = z.infer<typeof runtimeDbTableSummarySchema>;

export const runtimeDbTableDetailSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: z.enum(["table", "view"]),
	columns: z.array(runtimeDbColumnSchema),
});
export type RuntimeDbTableDetail = z.infer<typeof runtimeDbTableDetailSchema>;

export const runtimeDbTablesRequestSchema = z.object({
	connId: z.string().min(1),
	/** Optional schema filter (matched case-insensitively). */
	schema: z.string().optional(),
});
export type RuntimeDbTablesRequest = z.infer<typeof runtimeDbTablesRequestSchema>;

export const runtimeDbTablesResponseSchema = z.object({
	connId: z.string(),
	engine: runtimeDbEngineSchema,
	tables: z.array(runtimeDbTableSummarySchema),
});
export type RuntimeDbTablesResponse = z.infer<typeof runtimeDbTablesResponseSchema>;

export const runtimeDbDescribeRequestSchema = z.object({
	connId: z.string().min(1),
	table: z.string().min(1),
	/** Optional schema qualifier (matched case-insensitively). */
	schema: z.string().optional(),
});
export type RuntimeDbDescribeRequest = z.infer<typeof runtimeDbDescribeRequestSchema>;

export const runtimeDbDescribeResponseSchema = z.object({
	connId: z.string(),
	engine: runtimeDbEngineSchema,
	table: runtimeDbTableDetailSchema.nullable(),
});
export type RuntimeDbDescribeResponse = z.infer<typeof runtimeDbDescribeResponseSchema>;

export const runtimeDbQueryFieldSchema = z.object({
	name: z.string(),
	dataTypeId: z.number().optional(),
	dataType: z.string().optional(),
});
export type RuntimeDbQueryField = z.infer<typeof runtimeDbQueryFieldSchema>;

export const runtimeDbQueryRequestSchema = z.object({
	connId: z.string().min(1),
	sql: z.string().min(1),
	/** Page size for reads; clamped by the core's hard row cap. */
	pageSize: z.number().int().positive().optional(),
	/** Opaque next-page cursor returned by a prior query. */
	cursor: z.string().nullable().optional(),
});
export type RuntimeDbQueryRequest = z.infer<typeof runtimeDbQueryRequestSchema>;

export const runtimeDbQueryResponseSchema = z.object({
	connId: z.string(),
	columns: z.array(runtimeDbQueryFieldSchema),
	rows: z.array(z.record(z.string(), z.unknown())),
	rowCount: z.number(),
	affectedRows: z.number().nullable(),
	classification: z.enum(["read", "write", "ddl", "unknown"]),
	readOnly: z.boolean(),
	durationMs: z.number(),
	totalDurationMs: z.number(),
	pagination: z.object({
		paginated: z.boolean(),
		pageSize: z.number(),
		hasMore: z.boolean(),
		nextCursor: z.string().nullable(),
	}),
	truncated: z.object({
		byRows: z.boolean(),
		byBytes: z.boolean(),
	}),
});
export type RuntimeDbQueryResponse = z.infer<typeof runtimeDbQueryResponseSchema>;

export const runtimeDbBrowseRequestSchema = z.object({
	connId: z.string().min(1),
	/** Schema/namespace the table lives in. */
	schema: z.string().min(1),
	/** Table or view name to browse. */
	table: z.string().min(1),
	/** Page size; clamped by the core's hard row cap. */
	pageSize: z.number().int().positive().optional(),
	/** Opaque next-page cursor returned by a prior browse (keyset or offset-fallback). */
	cursor: z.string().nullable().optional(),
});
export type RuntimeDbBrowseRequest = z.infer<typeof runtimeDbBrowseRequestSchema>;

/** Browse reuses the query response shape (a bounded, paginated read of one table). */
export const runtimeDbBrowseResponseSchema = runtimeDbQueryResponseSchema;
export type RuntimeDbBrowseResponse = z.infer<typeof runtimeDbBrowseResponseSchema>;

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
