import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { getAgentProviderConfig } from "../agent-sdk/kanban/agent-provider-config";
import {
	type RuntimeAgentId,
	type RuntimeBoardData,
	type RuntimeGitRepositoryInfo,
	type RuntimeHomeChatThreadsData,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	type RuntimeWorkspaceStateSaveRequest,
	runtimeAgentIdSchema,
	runtimeHomeChatThreadsDataSchema,
	runtimeTaskSessionSummarySchema,
	runtimeWorkspaceStateSaveRequestSchema,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { updateTaskDependencies } from "../core/task-board-mutations";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { createLogger } from "../logging";
import { VaultDocumentStore } from "../vault/vault-document-store";
import { getVaultTypesDir } from "../vault/vault-paths";
import { seedVaultTypeDefinitions } from "../vault/vault-type-registry";
import {
	boardWorktreeHasCommittedData,
	codeBranchHasCommit,
	commitBoardWorktree,
	commitCodeBranchDecoupling,
	ensureBoardWorktree,
	getBoardWorktreeDataHome,
	isBoardRefTrackedOnCodeBranch,
	setupBoardWorktree,
} from "../workspace/board-worktree";
import {
	BOARD_REF_FILENAME,
	BOARD_REF_VERSION,
	DEFAULT_BOARD_BRANCH,
	isBoardDecouplingActive,
	writeBoardRef,
} from "./board-ref";
import {
	buildCommittedProviderFromProviderSettings,
	type CommittedProviderRecord,
	type CommittedProvidersData,
	normalizeProviderId,
	readCommittedProviders,
	writeCommittedProviders,
} from "./committed-provider-store";
import {
	collectRelatedTasks,
	type LegacyRequirementsData,
	type LegacyRequirementTaskLinksData,
	legacyRequirementItemSchema,
	legacyRequirementsDataSchema,
	legacyRequirementTaskLinkSchema,
	legacyRequirementTaskLinksDataSchema,
	REQUIREMENT_DOC_TYPE,
	requirementItemToVaultImport,
} from "./requirement-vault-migration";
import { readShardDir } from "./sharded-json-store";
import { boardNeedsSharding, convertBoardToShards, loadShardedBoard, saveShardedBoard } from "./task-shard-store";

const log = createLogger("workspace-state");

const RUNTIME_HOME_DIR = ".kanban";
const RUNTIME_WORKTREES_DIR = "worktrees";
const RUNTIME_TRASHED_PATCHES_DIR = "trashed-task-patches";
const WORKSPACES_DIR = "workspaces";
const INDEX_FILENAME = "index.json";
const SESSIONS_FILENAME = "sessions.json";
const REQUIREMENTS_FILENAME = "requirements.json";
const REQUIREMENT_VERSIONS_FILENAME = "requirement-versions.json";
const REQUIREMENT_TASK_LINKS_FILENAME = "requirement-task-links.json";
// Requirement data is sharded by requirement id into these directories (one
// `<reqId>.json` per requirement) so cross-branch edits to different requirements
// never collide on a single file. The `*_FILENAME` single files above remain only
// as migration sources + pre-sharding read fallbacks.
const REQUIREMENTS_SHARD_DIRNAME = "requirements";
const REQUIREMENT_VERSIONS_SHARD_DIRNAME = "requirement-versions";
const REQUIREMENT_TASK_LINKS_SHARD_DIRNAME = "requirement-task-links";
// The vault's readable-document channel: `<repo>/.kanban/files/docs/`. Requirements
// migrate into `docs/<REQUIREMENT_DOC_TYPE>/` (repo-scoped, like the file library),
// not the per-workspace requirement shards above.
const FILES_DIRNAME = "files";
const DOCS_DIRNAME = "docs";
const HOME_THREADS_FILENAME = "threads.json";
// Workspace-committed providers (secret-free). Sharded by provider id (one
// `<providerId>.json` per provider) so cross-branch provider edits never collide;
// the small selection map (each agent's currently selected committed provider)
// lives in a sibling file. Both are committed (non-secret config only — secrets
// stay in the machine-home agent_providers.json store).
const COMMITTED_PROVIDERS_SHARD_DIRNAME = "agent-providers";
const COMMITTED_PROVIDER_SELECTION_FILENAME = "agent-provider-selection.json";
// Legacy (retired) per-agent profile artifacts, migrated into committed providers.
const LEGACY_AGENT_PROFILES_SHARD_DIRNAME = "agent-profiles";
const LEGACY_AGENT_PROFILE_SELECTION_FILENAME = "agent-profile-selection.json";
const META_FILENAME = "meta.json";
const RUNTIME_HOME_GITIGNORE_FILENAME = ".gitignore";
// Boundary between committed content and machine-local runtime/secrets inside a
// repo's `.kanban`. Denylist style: committed directories (per-task shards in
// tasks/ and the file library in files/, including the vault's docs/ markdown)
// are tracked by default; only known runtime + secret paths are ignored. Binary
// file-library content goes through Git LFS, configured by files/.gitattributes
// (see src/files/file-library-store.ts).
const RUNTIME_HOME_GITIGNORE_CONTENT = `# Kanban runtime data boundary — see docs/superpowers/plans for rationale.
# Committed (content): workspaces/<id>/board.json (layout) + tasks/<id>.json, and
# files/ (manifest + LFS blobs + the vault's docs/ markdown). Everything below is
# machine-local or secret.

# Machine-local runtime state
worktrees/
trashed-task-patches/
**/sessions.json
**/sessions/
**/meta.json
*.lock
.workspaces.lock
**/*.lock

# Secrets (defensive — primary copies live in ~/.kanban, never here)
settings/
config.json
**/provider_settings.json
**/*_oauth_settings.json
`;
// Code-branch (repo root) `.gitignore` flip applied by the board-branch decouple
// migration: ignore the *contents* of `.kanban/` (so the board worktree's data, the
// task worktrees, sessions, etc. never dirty the code tree) while re-including the
// single `board-ref` pointer that tells a clone which branch holds the board data.
// `/.kanban/*` (not `/.kanban/`) is deliberate: ignoring contents rather than the
// directory itself is what lets the `!` negation re-include a child file.
const ROOT_GITIGNORE_FILENAME = ".gitignore";
const ROOT_GITIGNORE_KANBAN_MARKER = "/.kanban/*";
const ROOT_GITIGNORE_KANBAN_BLOCK = `# Kanban board data lives on its own branch; only the pointer travels with the code.
# See .plan/docs/board-branch-decoupling.md and .kanban/board-ref.
/.kanban/*
!/.kanban/board-ref
`;
const BOARD_IMPORT_COMMIT_MESSAGE = "board: import existing kanban data";
const INDEX_VERSION = 1;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

interface WorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

export interface RuntimeWorkspaceIndexEntry {
	workspaceId: string;
	repoPath: string;
}

interface WorkspaceIndexFile {
	version: number;
	entries: Record<string, WorkspaceIndexEntry>;
	repoPathToId: Record<string, string>;
}

interface WorkspaceStateMeta {
	revision: number;
	updatedAt: number;
}

const workspaceStateMetaSchema = z.object({
	revision: z.number().int().nonnegative(),
	updatedAt: z.number(),
});

const workspaceIndexEntrySchema = z.object({
	workspaceId: z.string().min(1, "Workspace ID cannot be empty."),
	repoPath: z.string().min(1, "Workspace repository path cannot be empty."),
});

const workspaceIndexFileSchema = z
	.object({
		version: z.literal(INDEX_VERSION),
		entries: z.record(z.string(), workspaceIndexEntrySchema),
		repoPathToId: z.record(z.string(), z.string().min(1, "Workspace ID cannot be empty.")),
	})
	.superRefine((index, context) => {
		for (const [workspaceId, entry] of Object.entries(index.entries)) {
			if (entry.workspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "workspaceId"],
					message: `Workspace ID must match entry key "${workspaceId}".`,
				});
			}
			const mappedWorkspaceId = index.repoPathToId[entry.repoPath];
			if (mappedWorkspaceId !== workspaceId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["entries", workspaceId, "repoPath"],
					message: `Missing repoPathToId mapping for "${entry.repoPath}" to "${workspaceId}".`,
				});
			}
		}

		for (const [repoPath, workspaceId] of Object.entries(index.repoPathToId)) {
			const entry = index.entries[workspaceId];
			if (!entry) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped workspace "${workspaceId}" does not exist in entries.`,
				});
				continue;
			}
			if (entry.repoPath !== repoPath) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["repoPathToId", repoPath],
					message: `Mapped repoPath does not match workspace entry path "${entry.repoPath}".`,
				});
			}
		}
	});

const workspaceSessionsSchema = z
	.record(z.string(), runtimeTaskSessionSummarySchema)
	.superRefine((sessions, context) => {
		for (const [taskId, session] of Object.entries(sessions)) {
			if (session.taskId !== taskId) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [taskId, "taskId"],
					message: `Session taskId must match record key "${taskId}".`,
				});
			}
		}
	});

export interface RuntimeWorkspaceContext {
	repoPath: string;
	workspaceId: string;
	statePath: string;
	git: RuntimeGitRepositoryInfo;
	/** Resolved runtime vs committed `.kanban` roots for this workspace (see {@link resolveBoardDataLocation}). */
	boardData: BoardDataLocation;
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function createEmptyWorkspaceIndex(): WorkspaceIndexFile {
	return {
		version: INDEX_VERSION,
		entries: {},
		repoPathToId: {},
	};
}

/**
 * Machine-level Kanban home (`~/.kanban`). Holds cross-repo state that must not
 * live inside any single repository: the workspace index registry, secrets
 * (`settings/`), runtime config (`config.json`), pi logs, and agent hook shims.
 * Per-workspace content + per-repo runtime live under {@link getRuntimeHomePath}.
 */
export function getMachineKanbanHomePath(): string {
	return join(homedir(), RUNTIME_HOME_DIR);
}

/**
 * Per-repo Kanban home (`<repoPath>/.kanban`). Holds this workspace's content
 * (board/requirements, committed) and per-repo runtime (worktrees, sessions,
 * locks — gitignored). See `<repoPath>/.kanban/.gitignore` for the boundary.
 */
export function getRuntimeHomePath(repoPath: string): string {
	return join(repoPath, RUNTIME_HOME_DIR);
}

/**
 * The two `.kanban` roots a workspace's data is split across.
 *
 * - `runtimeHome` — machine-local runtime state that must stay in the main
 *   checkout: task worktrees, trashed patches, sessions, meta, locks.
 * - `boardDataHome` — committed board data that travels with the repository:
 *   `board.json`/`tasks`, the vault (`files/docs`), the file library (`files/`),
 *   home-chat threads, and committed providers.
 *
 * Today both point at `<repo>/.kanban`, so the on-disk layout is byte-for-byte the
 * single-root layout and behavior is unchanged. The board-branch decoupling work
 * (`.plan/docs/board-branch-decoupling.md`) repoints `boardDataHome` to a dedicated
 * board worktree's `.kanban` while `runtimeHome` stays in the main checkout.
 */
export interface BoardDataLocation {
	runtimeHome: string;
	boardDataHome: string;
}

/**
 * Resolve a repo's runtime vs committed `.kanban` roots — the single seam through
 * which {@link BoardDataLocation} is produced. When board-branch decoupling is
 * active (the `.kanban/board-ref` pointer exists), committed board data lives in
 * the board worktree, so `boardDataHome` points at `<boardWorktree>/.kanban` while
 * `runtimeHome` stays in the main checkout. Otherwise both equal `<repo>/.kanban`
 * (the single-root layout), so behavior is unchanged until a repo opts in.
 */
export function resolveBoardDataLocation(repoPath: string): BoardDataLocation {
	const runtimeHome = getRuntimeHomePath(repoPath);
	if (isBoardDecouplingActive(repoPath)) {
		return { runtimeHome, boardDataHome: getBoardWorktreeDataHome(repoPath) };
	}
	return { runtimeHome, boardDataHome: runtimeHome };
}

/** Derive the `workspaces/` root inside a given `.kanban` home (runtime or board-data). */
function getWorkspacesRoot(kanbanHome: string): string {
	return join(kanbanHome, WORKSPACES_DIR);
}

/** Derive a `workspaces/<id>/` directory inside a given `.kanban` home. */
function getWorkspaceDirectory(kanbanHome: string, workspaceId: string): string {
	return join(getWorkspacesRoot(kanbanHome), workspaceId);
}

export function getTaskWorktreesHomePath(repoPath: string): string {
	return join(getRuntimeHomePath(repoPath), RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(repoPath: string): string {
	return getWorkspacesRoot(getRuntimeHomePath(repoPath));
}

/** The workspace index is the cross-repo registry, so it stays machine-rooted. */
function getWorkspaceIndexPath(): string {
	return join(getMachineKanbanHomePath(), WORKSPACES_DIR, INDEX_FILENAME);
}

/**
 * The runtime (machine-local) `workspaces/<id>/` directory: sessions, meta, and
 * the workspace lock. This is the lock anchor (see §3.4 of the board-branch
 * decoupling design), so it always lives in the main checkout's `.kanban`.
 */
export function getWorkspaceDirectoryPath(repoPath: string, workspaceId: string): string {
	return getWorkspaceDirectory(getRuntimeHomePath(repoPath), workspaceId);
}

/**
 * The committed (board-data) `workspaces/<id>/` directory: `board.json`/`tasks`,
 * home-chat threads, committed providers, and the migration-only requirement
 * shards. A distinct seam from {@link getWorkspaceDirectoryPath} (runtime) so the
 * board worktree work can relocate committed data without moving sessions, meta,
 * or locks. Resolves to the same path as the runtime dir while both roots coincide.
 */
function getBoardDataWorkspaceDirectoryPath(repoPath: string, workspaceId: string): string {
	return getWorkspaceDirectory(resolveBoardDataLocation(repoPath).boardDataHome, workspaceId);
}

/**
 * Old machine-rooted workspace directory (`~/.kanban/workspaces/<id>`). Used as
 * the copy-migration source and the read fallback when the repo-rooted location
 * does not yet exist. Never written to.
 */
function getLegacyWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getMachineKanbanHomePath(), WORKSPACES_DIR, workspaceId);
}

function getWorkspaceSessionsPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), SESSIONS_FILENAME);
}

/**
 * Directory holding per-task message transcripts:
 * `<repoPath>/.kanban/workspaces/<workspaceId>/sessions/<taskId>/messages.jsonl`.
 * Distinct from the `sessions.json` summary file in the same workspace dir.
 */
export function getWorkspaceSessionMessagesDirPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), "sessions");
}

function getWorkspaceRequirementsPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENTS_FILENAME);
}

function getWorkspaceRequirementVersionsPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_VERSIONS_FILENAME);
}

function getWorkspaceRequirementTaskLinksPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_TASK_LINKS_FILENAME);
}

function getWorkspaceRequirementsShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENTS_SHARD_DIRNAME);
}

function getWorkspaceRequirementVersionsShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_VERSIONS_SHARD_DIRNAME);
}

function getWorkspaceRequirementTaskLinksShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_TASK_LINKS_SHARD_DIRNAME);
}

/** Repo-scoped vault directory holding migrated requirement documents (`.md`). */
function getRequirementDocsDir(repoPath: string): string {
	return join(resolveBoardDataLocation(repoPath).boardDataHome, FILES_DIRNAME, DOCS_DIRNAME, REQUIREMENT_DOC_TYPE);
}

function getWorkspaceHomeThreadsPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), HOME_THREADS_FILENAME);
}

function getWorkspaceCommittedProvidersShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), COMMITTED_PROVIDERS_SHARD_DIRNAME);
}

function getWorkspaceCommittedProviderSelectionPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), COMMITTED_PROVIDER_SELECTION_FILENAME);
}

function getLegacyWorkspaceAgentProfilesShardDir(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), LEGACY_AGENT_PROFILES_SHARD_DIRNAME);
}

function getLegacyWorkspaceAgentProfileSelectionPath(repoPath: string, workspaceId: string): string {
	return join(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), LEGACY_AGENT_PROFILE_SELECTION_FILENAME);
}

function getWorkspaceMetaPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), META_FILENAME);
}

function getWorkspaceIndexLockRequest(): LockRequest {
	return {
		path: getWorkspaceIndexPath(),
		type: "file",
	};
}

function getWorkspaceDirectoryLockRequest(repoPath: string, workspaceId: string): LockRequest {
	return {
		path: getWorkspaceDirectoryPath(repoPath, workspaceId),
		type: "directory",
		lockfilePath: join(getWorkspacesRootPath(repoPath), `${workspaceId}.lock`),
	};
}

function getWorkspacesRootLockRequest(repoPath: string): LockRequest {
	return {
		path: getWorkspacesRootPath(repoPath),
		type: "directory",
		lockfileName: ".workspaces.lock",
	};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Malformed JSON in ${path}. ${message}`);
		}
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return null;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read JSON file at ${path}. ${message}`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}

/**
 * Read JSON from the repo-rooted `primaryPath`, falling back to the old
 * machine-rooted `legacyPath` (`~/.kanban/...`) only when the primary file does
 * not exist. Once the repo location has the file, it is authoritative — a
 * present-but-empty/`null` file is respected and never overridden by the legacy
 * copy. Writes always target the primary path. See {@link migrateWorkspaceDataFromLegacyHome}.
 */
async function readJsonFileWithLegacyFallback(primaryPath: string, legacyPath: string): Promise<unknown | null> {
	if (await pathExists(primaryPath)) {
		return await readJsonFile(primaryPath);
	}
	return await readJsonFile(legacyPath);
}

function getLegacyWorkspaceFilePath(workspaceId: string, filename: string): string {
	return join(getLegacyWorkspaceDirectoryPath(workspaceId), filename);
}

function formatSchemaIssuePath(pathSegments: PropertyKey[]): string {
	if (pathSegments.length === 0) {
		return "root";
	}
	return pathSegments
		.map((segment) => {
			if (typeof segment === "number") {
				return `[${segment}]`;
			}
			return String(segment);
		})
		.join(".");
}

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues.map((issue) => `${formatSchemaIssuePath(issue.path)}: ${issue.message}`).join("; ");
}

function parsePersistedStateFile<T>(
	filePath: string,
	fileLabel: string,
	raw: unknown | null,
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	defaultValue: T,
): T {
	if (raw === null) {
		return defaultValue;
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`Invalid ${fileLabel} file at ${filePath}. ` +
				`Fix or remove the file. Validation errors: ${formatSchemaIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

function parseWorkspaceIndex(rawIndex: unknown | null): WorkspaceIndexFile {
	const indexPath = getWorkspaceIndexPath();
	return parsePersistedStateFile(
		indexPath,
		INDEX_FILENAME,
		rawIndex,
		workspaceIndexFileSchema,
		createEmptyWorkspaceIndex(),
	);
}

function parseWorkspaceStateSavePayload(payload: RuntimeWorkspaceStateSaveRequest): RuntimeWorkspaceStateSaveRequest {
	const parsed = runtimeWorkspaceStateSaveRequestSchema.safeParse(payload);
	if (!parsed.success) {
		throw new Error(`Invalid workspace state save payload. ${formatSchemaIssues(parsed.error)}`);
	}
	return parsed.data;
}

async function readWorkspaceBoard(repoPath: string, workspaceId: string): Promise<RuntimeBoardData> {
	// The board is stored sharded (one `tasks/<id>.json` per task + a layout-only
	// `board.json`); loadShardedBoard assembles the wire-shaped board, staying
	// back-compatible with a legacy single-file board and the machine-rooted fallback.
	const board = await loadShardedBoard(
		getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId),
		getLegacyWorkspaceDirectoryPath(workspaceId),
	);
	return updateTaskDependencies(board);
}

export async function loadWorkspaceBoardById(workspaceId: string): Promise<RuntimeBoardData> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	return await readWorkspaceBoard(repoPath, workspaceId);
}

async function readWorkspaceSessions(
	repoPath: string,
	workspaceId: string,
): Promise<Record<string, RuntimeTaskSessionSummary>> {
	const sessionsPath = getWorkspaceSessionsPath(repoPath, workspaceId);
	const rawSessions = await readJsonFileWithLegacyFallback(
		sessionsPath,
		getLegacyWorkspaceFilePath(workspaceId, SESSIONS_FILENAME),
	);
	return parsePersistedStateFile(sessionsPath, SESSIONS_FILENAME, rawSessions, workspaceSessionsSchema, {});
}

/**
 * Read legacy requirement items from the shard channel (or pre-shard single-file
 * fallback) for the **one-time vault migration only**. The requirement subsystem
 * is retired (B6); this exists solely so {@link migrateRequirementsToVaultDocs}
 * can read any pre-vault data still on disk and crystallize it into documents.
 */
async function readLegacyRequirements(repoPath: string, workspaceId: string): Promise<LegacyRequirementsData> {
	const shardDir = getWorkspaceRequirementsShardDir(repoPath, workspaceId);
	if (await pathExists(shardDir)) {
		const shards = await readShardDir(shardDir, legacyRequirementItemSchema);
		return { items: [...shards.values()] };
	}
	const requirementsPath = getWorkspaceRequirementsPath(repoPath, workspaceId);
	const rawRequirements = await readJsonFileWithLegacyFallback(
		requirementsPath,
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENTS_FILENAME),
	);
	return parsePersistedStateFile(
		requirementsPath,
		REQUIREMENTS_FILENAME,
		rawRequirements,
		legacyRequirementsDataSchema,
		{
			items: [],
		},
	);
}

/**
 * Read legacy requirement → task link records from the shard channel (or
 * pre-shard single-file fallback), again for the one-time vault migration only:
 * the links collapse into each requirement's `related_tasks` frontmatter.
 */
async function readLegacyRequirementTaskLinks(
	repoPath: string,
	workspaceId: string,
): Promise<LegacyRequirementTaskLinksData> {
	const shardDir = getWorkspaceRequirementTaskLinksShardDir(repoPath, workspaceId);
	if (await pathExists(shardDir)) {
		const shards = await readShardDir(shardDir, z.array(legacyRequirementTaskLinkSchema));
		return { links: [...shards.values()].flat() };
	}
	const linksPath = getWorkspaceRequirementTaskLinksPath(repoPath, workspaceId);
	const rawLinks = await readJsonFileWithLegacyFallback(
		linksPath,
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENT_TASK_LINKS_FILENAME),
	);
	return parsePersistedStateFile(
		linksPath,
		REQUIREMENT_TASK_LINKS_FILENAME,
		rawLinks,
		legacyRequirementTaskLinksDataSchema,
		{
			links: [],
		},
	);
}

async function readWorkspaceHomeThreads(repoPath: string, workspaceId: string): Promise<RuntimeHomeChatThreadsData> {
	const threadsPath = getWorkspaceHomeThreadsPath(repoPath, workspaceId);
	// Home chat threads are a new (post-relocation) feature: no legacy location to fall back to.
	const rawThreads = await readJsonFile(threadsPath);
	return parsePersistedStateFile(threadsPath, HOME_THREADS_FILENAME, rawThreads, runtimeHomeChatThreadsDataSchema, {
		threads: [],
	});
}

/** Read the persisted home chat thread registry for a workspace. */
export async function loadWorkspaceHomeThreads(workspaceId: string): Promise<RuntimeHomeChatThreadsData> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	return await readWorkspaceHomeThreads(repoPath, workspaceId);
}

/**
 * Atomically read → transform → write the home chat thread registry under the
 * workspace directory lock. The `mutate` callback is pure (see
 * `home-thread-registry.ts`); persistence and locking are owned here. Returns
 * the persisted data.
 */
export async function mutateWorkspaceHomeThreads(
	workspaceId: string,
	mutate: (current: RuntimeHomeChatThreadsData) => RuntimeHomeChatThreadsData,
): Promise<RuntimeHomeChatThreadsData> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const current = await readWorkspaceHomeThreads(repoPath, workspaceId);
		const next = mutate(current);
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceHomeThreadsPath(repoPath, workspaceId), next, {
			lock: null,
		});
		return next;
	});
}

/** Read the persisted committed-provider registry (sharded providers + selection) for a workspace. */
export async function loadWorkspaceCommittedProviders(workspaceId: string): Promise<CommittedProvidersData> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	return await readCommittedProviders(
		getWorkspaceCommittedProvidersShardDir(repoPath, workspaceId),
		getWorkspaceCommittedProviderSelectionPath(repoPath, workspaceId),
	);
}

/**
 * Atomically read → transform → write the committed-provider registry under the
 * workspace directory lock. The `mutate` callback is pure; persistence and locking
 * are owned here. Returns the persisted data.
 */
export async function mutateWorkspaceCommittedProviders(
	workspaceId: string,
	mutate: (current: CommittedProvidersData) => CommittedProvidersData,
): Promise<CommittedProvidersData> {
	const repoPath = await resolveRepoPathForWorkspaceId(workspaceId);
	if (!repoPath) {
		throw new Error(`Unknown workspace "${workspaceId}"; cannot resolve its repository path.`);
	}
	const providersDir = getWorkspaceCommittedProvidersShardDir(repoPath, workspaceId);
	const selectionPath = getWorkspaceCommittedProviderSelectionPath(repoPath, workspaceId);
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const current = await readCommittedProviders(providersDir, selectionPath);
		const next = mutate(current);
		await writeCommittedProviders(providersDir, selectionPath, next);
		return next;
	});
}

async function readWorkspaceMeta(repoPath: string, workspaceId: string): Promise<WorkspaceStateMeta> {
	const metaPath = getWorkspaceMetaPath(repoPath, workspaceId);
	const rawMeta = await readJsonFileWithLegacyFallback(
		metaPath,
		getLegacyWorkspaceFilePath(workspaceId, META_FILENAME),
	);
	return parsePersistedStateFile(metaPath, META_FILENAME, rawMeta, workspaceStateMetaSchema, {
		revision: 0,
		updatedAt: 0,
	});
}

async function readWorkspaceIndex(): Promise<WorkspaceIndexFile> {
	const raw = await readJsonFile(getWorkspaceIndexPath());
	return parseWorkspaceIndex(raw);
}

async function writeWorkspaceIndex(index: WorkspaceIndexFile): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getWorkspaceIndexPath(), index, {
		lock: null,
	});
}

function toWorkspaceIdBase(repoPath: string): string {
	const trimmed = repoPath.trim().replace(/[\\/]+$/g, "");
	const folderName = basename(trimmed) || "project";
	const normalized = folderName
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "project";
}

function createWorkspaceIdCollisionSuffix(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let suffix = "";
	while (suffix.length < length) {
		const bytes = randomBytes(length);
		for (const byte of bytes) {
			suffix += alphabet[byte % alphabet.length] ?? "";
			if (suffix.length === length) {
				break;
			}
		}
	}
	return suffix;
}

function createWorkspaceId(index: WorkspaceIndexFile, repoPath: string): string {
	const baseId = toWorkspaceIdBase(repoPath);
	if (!index.entries[baseId] || index.entries[baseId]?.repoPath === repoPath) {
		return baseId;
	}

	for (let attempt = 0; attempt < 256; attempt += 1) {
		const candidate = `${baseId}-${createWorkspaceIdCollisionSuffix(WORKSPACE_ID_COLLISION_SUFFIX_LENGTH)}`;
		if (!index.entries[candidate] || index.entries[candidate]?.repoPath === repoPath) {
			return candidate;
		}
	}

	throw new Error(`Could not generate a unique workspace ID for ${repoPath}.`);
}

function ensureWorkspaceEntry(
	index: WorkspaceIndexFile,
	repoPath: string,
): { index: WorkspaceIndexFile; entry: WorkspaceIndexEntry; changed: boolean } {
	const existingWorkspaceId = index.repoPathToId[repoPath];
	if (existingWorkspaceId) {
		const existingEntry = index.entries[existingWorkspaceId];
		if (existingEntry && existingEntry.repoPath === repoPath) {
			return {
				index,
				entry: existingEntry,
				changed: false,
			};
		}
	}

	const workspaceId = createWorkspaceId(index, repoPath);

	const entry: WorkspaceIndexEntry = {
		workspaceId,
		repoPath,
	};

	return {
		index: {
			version: INDEX_VERSION,
			entries: {
				...index.entries,
				[workspaceId]: entry,
			},
			repoPathToId: {
				...index.repoPathToId,
				[repoPath]: workspaceId,
			},
		},
		entry,
		changed: true,
	};
}

function findWorkspaceEntry(index: WorkspaceIndexFile, repoPath: string): WorkspaceIndexEntry | null {
	const workspaceId = index.repoPathToId[repoPath];
	if (!workspaceId) {
		return null;
	}
	const entry = index.entries[workspaceId];
	if (!entry || entry.repoPath !== repoPath) {
		return null;
	}
	return entry;
}

/**
 * Resolve the repository path for a workspace id via the machine-level index.
 * Used by callers that only hold an id (e.g. `loadWorkspaceBoardById`) to locate
 * the repo-rooted data directory. Returns null when the id is not registered.
 */
export async function resolveRepoPathForWorkspaceId(workspaceId: string): Promise<string | null> {
	const index = await readWorkspaceIndex();
	return index.entries[workspaceId]?.repoPath ?? null;
}

/**
 * One-time copy of a workspace's data from the old machine-rooted location
 * (`~/.kanban/workspaces/<id>`) into the repo-rooted location
 * (`<repoPath>/.kanban/workspaces/<id>`). The source is never moved or deleted,
 * so the original `~/.kanban` keeps working and the migration is rollback-safe.
 * Idempotent: skips when the repo-rooted directory already exists.
 */
async function migrateWorkspaceDataFromLegacyHome(repoPath: string, workspaceId: string): Promise<void> {
	const target = getWorkspaceDirectoryPath(repoPath, workspaceId);
	if (await pathExists(target)) {
		return;
	}
	const legacy = getLegacyWorkspaceDirectoryPath(workspaceId);
	if (!(await pathExists(legacy))) {
		return;
	}
	await cp(legacy, target, { recursive: true, force: false, errorOnExist: false });
}

/**
 * Seed the built-in vault type definitions into `<repo>/.kanban/files/docs/_types/`
 * on first run. Types are data-driven (one `_types/<type>.md` per type, frontmatter
 * + an authoring prompt), so this writes the requirement/customer/decision/note
 * seeds once and then never again — the `_types/` directory guard makes re-runs a
 * no-op, and a workspace is free to edit or add types afterwards. Cheap dir-exists
 * precheck skips the workspace lock when there is nothing to do.
 */
async function migrateSeedVaultTypes(repoPath: string, workspaceId: string): Promise<void> {
	const typesDir = getVaultTypesDir(repoPath);
	if (await pathExists(typesDir)) {
		return;
	}
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		await seedVaultTypeDefinitions(typesDir);
	});
}

/**
 * One-time, idempotent conversion of a workspace's pre-vault requirement data
 * (per-id `requirements/` shards, or the older single-file `requirements.json` /
 * legacy-home fallback) into vault documents at
 * `<repo>/.kanban/files/docs/requirement/<slug>-<id>.md`. Runs after the T1 legacy
 * copy-migration, so a machine-home single file is already copied into the repo.
 * Each requirement becomes one markdown doc — description → body, delivery status →
 * PROBLEM state, links → `related_tasks` — preserving the original id and
 * timestamps. The `docs/requirement/` guard makes re-runs a no-op; the legacy
 * on-disk sources are removed by {@link dropRetiredRequirementData}, which runs
 * immediately after in {@link prepareRepoRuntimeHome}.
 */
async function migrateRequirementsToVaultDocs(repoPath: string, workspaceId: string): Promise<void> {
	if (await pathExists(getRequirementDocsDir(repoPath))) {
		return;
	}
	// Cheap source-presence precheck: skip the lock when there is nothing to migrate.
	const sourcePaths = [
		getWorkspaceRequirementsShardDir(repoPath, workspaceId),
		getWorkspaceRequirementsPath(repoPath, workspaceId),
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENTS_FILENAME),
	];
	const present = await Promise.all(sourcePaths.map((path) => pathExists(path)));
	if (!present.some(Boolean)) {
		return;
	}
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		if (await pathExists(getRequirementDocsDir(repoPath))) {
			return;
		}
		const requirements = await readLegacyRequirements(repoPath, workspaceId);
		if (requirements.items.length === 0) {
			return;
		}
		const links = (await readLegacyRequirementTaskLinks(repoPath, workspaceId)).links;
		const store = new VaultDocumentStore(repoPath);
		for (const item of requirements.items) {
			await store.importDocument(requirementItemToVaultImport(item, collectRelatedTasks(item, links)));
		}
	});
}

/**
 * Remove every pre-vault requirement source from a repo's workspace dir: the per-id
 * shard directories (`requirements/`, `requirement-versions/`,
 * `requirement-task-links/`) and their older single-file forms. Idempotent, with a
 * cheap presence precheck that skips the lock when nothing remains. Runs right after
 * {@link migrateRequirementsToVaultDocs} (which has already read whatever it needed),
 * so it both finishes a fresh migration and cleans up the version/task-link shards
 * left behind by the interim B5 migration. Machine-home (`~/.kanban`) originals are
 * never touched (non-destructive policy).
 */
async function dropRetiredRequirementData(repoPath: string, workspaceId: string): Promise<void> {
	const retiredPaths = [
		getWorkspaceRequirementsShardDir(repoPath, workspaceId),
		getWorkspaceRequirementVersionsShardDir(repoPath, workspaceId),
		getWorkspaceRequirementTaskLinksShardDir(repoPath, workspaceId),
		getWorkspaceRequirementsPath(repoPath, workspaceId),
		getWorkspaceRequirementVersionsPath(repoPath, workspaceId),
		getWorkspaceRequirementTaskLinksPath(repoPath, workspaceId),
	];
	const present = await Promise.all(retiredPaths.map((path) => pathExists(path)));
	if (!present.some(Boolean)) {
		return;
	}
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		await Promise.all(retiredPaths.map((path) => rm(path, { recursive: true, force: true })));
	});
}

/**
 * Write the `.gitignore` that draws the git boundary for a repo's `.kanban`:
 * task definitions + requirements are committed; runtime state, worktrees,
 * locks, and secrets are ignored. Never overwrites a user-edited file.
 */
async function ensureRuntimeHomeGitignore(repoPath: string): Promise<void> {
	const gitignorePath = join(getRuntimeHomePath(repoPath), RUNTIME_HOME_GITIGNORE_FILENAME);
	if (await pathExists(gitignorePath)) {
		return;
	}
	await mkdir(getRuntimeHomePath(repoPath), { recursive: true });
	await writeFile(gitignorePath, RUNTIME_HOME_GITIGNORE_CONTENT, "utf8");
}

function runGitCapture(cwd: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitProcessEnv(),
	});
	if (result.status !== 0 || typeof result.stdout !== "string") {
		return null;
	}
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

function detectGitRoot(cwd: string): string | null {
	return runGitCapture(cwd, ["rev-parse", "--show-toplevel"]);
}

function detectGitCurrentBranch(repoPath: string): string | null {
	return runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

function detectGitBranches(repoPath: string): string[] {
	// TODO: support showing remote branches again once worktree creation can safely fetch/pull
	// and resolve missing local tracking branches automatically.
	const output = runGitCapture(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	if (!output) {
		return [];
	}

	const unique = new Set<string>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "HEAD") {
			continue;
		}
		unique.add(trimmed);
	}
	return Array.from(unique).sort((left, right) => left.localeCompare(right));
}

function detectGitDefaultBranch(repoPath: string, branches: string[]): string | null {
	const remoteHead = runGitCapture(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (remoteHead) {
		const normalized = remoteHead.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
		if (normalized) {
			return normalized;
		}
	}
	if (branches.includes("main")) {
		return "main";
	}
	if (branches.includes("master")) {
		return "master";
	}
	return branches[0] ?? null;
}

function detectGitRepositoryInfo(repoPath: string): RuntimeGitRepositoryInfo {
	const gitRoot = detectGitRoot(repoPath);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${repoPath}`);
	}

	const currentBranch = detectGitCurrentBranch(repoPath);
	const branches = detectGitBranches(repoPath);
	const orderedBranches = currentBranch && !branches.includes(currentBranch) ? [currentBranch, ...branches] : branches;
	const defaultBranch = detectGitDefaultBranch(repoPath, orderedBranches);

	return {
		currentBranch,
		defaultBranch,
		branches: orderedBranches,
	};
}

async function resolveWorkspacePath(cwd: string): Promise<string> {
	const resolvedCwd = resolve(cwd);
	let canonicalCwd = resolvedCwd;
	try {
		canonicalCwd = await realpath(resolvedCwd);
	} catch {
		canonicalCwd = resolvedCwd;
	}

	const gitRoot = detectGitRoot(canonicalCwd);
	if (!gitRoot) {
		throw new Error(`No git repository detected at ${canonicalCwd}`);
	}

	const resolvedGitRoot = resolve(gitRoot);
	try {
		return await realpath(resolvedGitRoot);
	} catch {
		return resolvedGitRoot;
	}
}

function toWorkspaceStateResponse(
	context: RuntimeWorkspaceContext,
	board: RuntimeBoardData,
	sessions: Record<string, RuntimeTaskSessionSummary>,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		board,
		sessions,
		revision,
	};
}

export class WorkspaceStateConflictError extends Error {
	readonly currentRevision: number;

	constructor(expectedRevision: number, currentRevision: number) {
		super(`Workspace state revision mismatch: expected ${expectedRevision}, current ${currentRevision}.`);
		this.name = "WorkspaceStateConflictError";
		this.currentRevision = currentRevision;
	}
}

export async function loadWorkspaceContext(
	cwd: string,
	options: LoadWorkspaceContextOptions = {},
): Promise<RuntimeWorkspaceContext> {
	const repoPath = await resolveWorkspacePath(cwd);
	const autoCreateIfMissing = options.autoCreateIfMissing ?? true;
	if (!autoCreateIfMissing) {
		const index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		if (!existingEntry) {
			throw new Error(`Project ${repoPath} is not added to Kanban yet.`);
		}
		await prepareRepoRuntimeHome(repoPath, existingEntry.workspaceId);
		return {
			repoPath,
			workspaceId: existingEntry.workspaceId,
			statePath: getWorkspaceDirectoryPath(repoPath, existingEntry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
			boardData: resolveBoardDataLocation(repoPath),
		};
	}

	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		let index = await readWorkspaceIndex();
		const existingEntry = findWorkspaceEntry(index, repoPath);
		const ensured = existingEntry
			? { index, entry: existingEntry, changed: false }
			: ensureWorkspaceEntry(index, repoPath);
		index = ensured.index;
		if (ensured.changed) {
			await writeWorkspaceIndex(index);
		}

		await prepareRepoRuntimeHome(repoPath, ensured.entry.workspaceId);
		return {
			repoPath,
			workspaceId: ensured.entry.workspaceId,
			statePath: getWorkspaceDirectoryPath(repoPath, ensured.entry.workspaceId),
			git: detectGitRepositoryInfo(repoPath),
			boardData: resolveBoardDataLocation(repoPath),
		};
	});
}

/**
 * Repos whose `.kanban` reached the fully-prepared terminal state earlier in this
 * process. `loadWorkspaceContext` runs on many hot paths (registry init, every
 * `loadWorkspaceState`, the projects tRPC api, task-worktree ops), and on an
 * already-migrated repo the whole {@link prepareRepoRuntimeHome} chain degrades to a
 * handful of serial `pathExists`/`stat` probes plus two `git` spawns
 * (`isGitWorktree` + `isBoardRefTrackedOnCodeBranch`, ~10-15ms each) that can only
 * ever answer "nothing to do". Caching the terminal state lets repeat in-process
 * calls skip the entire chain.
 *
 * The cache is keyed by repo path (the workspace id is derived 1:1 from it) and is
 * only populated once a repo reaches the **fully decoupled** terminal state —
 * `migrateDecoupleBoardToBranch` returning `true`. That state is reached last and
 * presupposes every earlier one-time migration has run, so it is the single
 * authoritative "nothing left to do" signal. Repos that legitimately cannot decouple
 * yet (unborn / no-commit) or that degraded mid-migration are never cached, so the
 * chain keeps re-running and retrying on every load exactly as before.
 */
const fullyPreparedRepoRuntimeHomes = new Set<string>();

/** Test-only: has this repo's runtime home been marked fully prepared in-process? */
export function isRepoRuntimeHomePreparedForTests(repoPath: string): boolean {
	return fullyPreparedRepoRuntimeHomes.has(repoPath);
}

/** Test-only: drop all in-process "fully prepared" marks so the chain re-runs. */
export function resetRepoRuntimeHomePreparedCacheForTests(): void {
	fullyPreparedRepoRuntimeHomes.clear();
}

/**
 * Ensure a repo's `.kanban` is ready: copy-migrate any legacy machine-rooted
 * data once, then ensure the git-boundary `.gitignore` exists. Idempotent and
 * non-destructive (never touches `~/.kanban`).
 *
 * Once a repo has reached the fully-prepared terminal state it is cached in
 * {@link fullyPreparedRepoRuntimeHomes} and repeat in-process calls return without
 * touching the filesystem or git.
 */
async function prepareRepoRuntimeHome(repoPath: string, workspaceId: string): Promise<void> {
	if (fullyPreparedRepoRuntimeHomes.has(repoPath)) {
		return;
	}
	// Reconcile the board worktree first so every downstream committed-data path
	// resolution sees a ready worktree. A no-op until board-branch decoupling is
	// activated (the `.kanban/board-ref` pointer is written by the P2 migration).
	await ensureBoardWorktree(repoPath);
	await migrateWorkspaceDataFromLegacyHome(repoPath, workspaceId);
	await ensureRuntimeHomeGitignore(repoPath);
	await migrateSeedVaultTypes(repoPath, workspaceId);
	await migrateRequirementsToVaultDocs(repoPath, workspaceId);
	await dropRetiredRequirementData(repoPath, workspaceId);
	await migrateWorkspaceBoardToShards(repoPath, workspaceId);
	await migrateToCommittedProviders(repoPath, workspaceId);
	// Runs last so it seeds the board branch from the *final* committed state every
	// earlier migration produced in `<repo>/.kanban`. Its `true` return is the
	// authoritative "fully prepared" signal — cache it so later loads skip the chain.
	const fullyDecoupled = await migrateDecoupleBoardToBranch(repoPath, workspaceId);
	if (fullyDecoupled) {
		fullyPreparedRepoRuntimeHomes.add(repoPath);
	}
}

/**
 * One-time, idempotent migration that moves a repo's committed board data onto a
 * dedicated `kanban/board` branch (method C — see `.plan/docs/board-branch-decoupling.md`).
 * After it runs, the code branch no longer tracks `.kanban` data (only the
 * `board-ref` pointer), so switching code branches no longer fights the runtime's
 * constant `tasks/*.json` rewrites.
 *
 * Covers the three repo states uniformly:
 *  - **Existing / brand-new (no `board-ref` yet):** seed the orphan board branch from
 *    whatever committed data exists in `<repo>/.kanban` (a full board for an existing
 *    repo, just the vault-type seeds for a fresh one), write the pointer, then flip
 *    the code branch's `.gitignore` and untrack `.kanban` (keeping `board-ref`).
 *  - **Clone (`board-ref` arrives tracked):** the cheap gate skips this entirely;
 *    {@link ensureBoardWorktree} (run first in the chain) fetches + tracks the remote
 *    board branch, or initializes an empty one when the remote lacks it.
 *
 * The completion gate is `board-ref` being *tracked* on the code branch — the single
 * artifact written by the final decoupling commit — so a crash anywhere mid-flip is
 * retried (not skipped), and every step is individually idempotent: the worktree
 * setup, the seed (guarded by {@link boardWorktreeHasCommittedData} so a retry never
 * clobbers data written after a partial run), the `.gitignore` append, and the
 * `rm --cached` + commit. Rollback: revert the decouple commit to restore tracking,
 * or delete `board-ref` + the board branch to return to the pre-migration state.
 */
async function migrateDecoupleBoardToBranch(repoPath: string, workspaceId: string): Promise<boolean> {
	if (await isBoardRefTrackedOnCodeBranch(repoPath)) {
		return true;
	}
	// The pointer can only be tracked on top of a commit, so an unborn repo cannot be
	// decoupled yet — leave its data in the main checkout until it has a first commit.
	if (!(await codeBranchHasCommit(repoPath))) {
		return false;
	}
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		if (await isBoardRefTrackedOnCodeBranch(repoPath)) {
			return true;
		}
		const branch = DEFAULT_BOARD_BRANCH;
		try {
			const setup = await setupBoardWorktree(repoPath, branch);
			if (!setup.ok || !setup.path) {
				log.error("board decoupling: could not set up the board worktree; leaving data on the code branch", {
					repoPath,
					branch,
					error: setup.error,
				});
				return false;
			}

			// Seed the board branch only while it is still empty, so a retry after a
			// crash (which may have already taken live writes) never overwrites newer data.
			if (!(await boardWorktreeHasCommittedData(repoPath))) {
				await copyCommittedDataIntoBoardWorktree(repoPath);
				await commitBoardWorktree(repoPath, BOARD_IMPORT_COMMIT_MESSAGE);
			}

			// Activate decoupling, then untrack `.kanban` on the code branch. board-ref is
			// written before the code-branch commit so the commit can track it; the gate
			// keys off board-ref being *tracked*, so a crash between these steps retries.
			await writeBoardRef(repoPath, { version: BOARD_REF_VERSION, branch });
			await ensureCodeBranchKanbanIgnored(repoPath);
			await commitCodeBranchDecoupling(repoPath);
			return true;
		} catch (error) {
			// Never let a decouple failure brick a workspace load: degrade to the
			// undecoupled (or half-decoupled but worktree-seeded) state and retry next
			// load. The gate keys off board-ref being tracked, so this stays idempotent.
			log.error("board decoupling failed; leaving the workspace on the code branch for now", {
				repoPath,
				branch,
				error,
			});
			return false;
		}
	});
}

/**
 * Copy a repo's committed `.kanban` data into the board worktree's `.kanban`, mirroring
 * the layout so every committed-data path derivation works once `boardDataHome` repoints
 * there. Excludes `worktrees/` (the board worktree lives there — copying it would recurse)
 * and `trashed-task-patches/`; the board branch's own `.kanban/.gitignore` denylist (copied
 * along) keeps sessions/meta/locks out of the commit. `board-ref` is excluded — the pointer
 * never lives on the board branch itself (it would be a chicken-and-egg discovery loop).
 */
async function copyCommittedDataIntoBoardWorktree(repoPath: string): Promise<void> {
	const source = getRuntimeHomePath(repoPath);
	const dest = getBoardWorktreeDataHome(repoPath);
	await mkdir(dest, { recursive: true });
	const excluded = new Set([RUNTIME_WORKTREES_DIR, RUNTIME_TRASHED_PATCHES_DIR, BOARD_REF_FILENAME]);
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		if (excluded.has(entry.name)) {
			continue;
		}
		await cp(join(source, entry.name), join(dest, entry.name), { recursive: true, force: true });
	}
}

/**
 * Append the `/.kanban/*` + `!/.kanban/board-ref` rule to the repo's root `.gitignore`
 * (creating it if absent), idempotently — a second run is a no-op once the marker is
 * present. Never rewrites unrelated content.
 */
async function ensureCodeBranchKanbanIgnored(repoPath: string): Promise<void> {
	const gitignorePath = join(repoPath, ROOT_GITIGNORE_FILENAME);
	let existing = "";
	try {
		existing = await readFile(gitignorePath, "utf8");
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			throw error;
		}
	}
	if (existing.split(/\r?\n/).some((line) => line.trim() === ROOT_GITIGNORE_KANBAN_MARKER)) {
		return;
	}
	const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
	await writeFile(gitignorePath, `${existing}${separator}${ROOT_GITIGNORE_KANBAN_BLOCK}`, "utf8");
}

/**
 * One-time, idempotent setup of the workspace's committed (secret-free) providers.
 *
 * Gated on the absence of the `agent-providers/` directory so re-runs are a cheap
 * no-op. When it does run it produces the committed-provider registry from, in order:
 *
 *   1. a legacy retired `agent-profiles/` registry, if present — each profile with a
 *      provider becomes a committed provider keyed by provider id, and the selected
 *      profile's provider becomes the selected committed provider (then the legacy
 *      artifacts are removed); otherwise
 *   2. the user's machine-home per-agent provider config for `pi` — a single committed
 *      provider, selected for that agent.
 *
 * Secrets are NEVER copied: only non-secret config is committed; the API key stays in
 * the machine-home agent_providers.json store and is resolved at launch. Skipped
 * entirely (no directory created) when there is nothing to migrate.
 */
async function migrateToCommittedProviders(repoPath: string, workspaceId: string): Promise<void> {
	const providersDir = getWorkspaceCommittedProvidersShardDir(repoPath, workspaceId);
	if (await pathExists(providersDir)) {
		return;
	}

	const legacyProfilesDir = getLegacyWorkspaceAgentProfilesShardDir(repoPath, workspaceId);
	const legacyData = (await pathExists(legacyProfilesDir))
		? await readLegacyAgentProfilesAsCommittedProviders(
				legacyProfilesDir,
				getLegacyWorkspaceAgentProfileSelectionPath(repoPath, workspaceId),
			)
		: null;

	const data: CommittedProvidersData | null =
		legacyData ?? buildSingleCommittedProviderData(getAgentProviderConfig("pi"), "pi");

	if (!data) {
		return;
	}

	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		if (await pathExists(providersDir)) {
			return;
		}
		await writeCommittedProviders(
			providersDir,
			getWorkspaceCommittedProviderSelectionPath(repoPath, workspaceId),
			data,
		);
		// Remove the retired profile artifacts now that they live as committed providers.
		await rm(legacyProfilesDir, { recursive: true, force: true });
		await rm(getLegacyWorkspaceAgentProfileSelectionPath(repoPath, workspaceId), { force: true });
	});
}

/** Build a one-provider committed registry from a machine-home provider config (or null). */
function buildSingleCommittedProviderData(
	config: ReturnType<typeof getAgentProviderConfig>,
	agentId: RuntimeAgentId,
): CommittedProvidersData | null {
	const provider = buildCommittedProviderFromProviderSettings(config, agentId);
	if (!provider) {
		return null;
	}
	return { providers: [provider], selectedByAgent: { [provider.agentId]: provider.providerId } };
}

// Retired agent-profile shard shape (read-only, for migration). Only the fields that
// map onto a committed provider are needed; extras are ignored.
const legacyAgentProfileShardSchema = z
	.object({
		id: z.string(),
		agentId: runtimeAgentIdSchema,
		providerId: z.string().nullable().optional(),
		modelId: z.string().nullable().optional(),
		baseUrl: z.string().nullable().optional(),
		reasoningEffort: z.string().nullable().optional(),
		region: z.string().nullable().optional(),
		gcpProjectId: z.string().nullable().optional(),
		gcpRegion: z.string().nullable().optional(),
	})
	.passthrough();

const legacyAgentProfileSelectionSchema = z.object({
	selectedByAgent: z.record(z.string(), z.string()).default({}),
});

/**
 * Read a legacy `agent-profiles/` registry and project it onto committed providers.
 * Profiles without a provider are skipped; the selected profile (per agent) becomes
 * the selected committed provider. Returns null when no profile yields a provider.
 */
async function readLegacyAgentProfilesAsCommittedProviders(
	profilesDir: string,
	selectionPath: string,
): Promise<CommittedProvidersData | null> {
	const shardMap = await readShardDir(profilesDir, legacyAgentProfileShardSchema);
	const profileById = new Map<string, z.infer<typeof legacyAgentProfileShardSchema>>();
	const byProviderId = new Map<string, CommittedProviderRecord>();
	for (const profile of shardMap.values()) {
		profileById.set(profile.id, profile);
		const provider = buildCommittedProviderFromProviderSettings(
			{
				agentId: profile.agentId,
				provider: profile.providerId ?? undefined,
				model: profile.modelId ?? undefined,
				baseUrl: profile.baseUrl ?? undefined,
				reasoning: profile.reasoningEffort ? { effort: profile.reasoningEffort } : undefined,
				region: profile.region ?? undefined,
				gcp: { projectId: profile.gcpProjectId ?? undefined, region: profile.gcpRegion ?? undefined },
			},
			profile.agentId,
		);
		if (provider) {
			byProviderId.set(provider.providerId, provider);
		}
	}
	if (byProviderId.size === 0) {
		return null;
	}

	let selectedByAgent: Record<string, string> = {};
	try {
		const raw = await readFile(selectionPath, "utf8");
		const parsed = legacyAgentProfileSelectionSchema.safeParse(JSON.parse(raw) as unknown);
		if (parsed.success) {
			for (const [agentId, profileId] of Object.entries(parsed.data.selectedByAgent)) {
				const providerId = normalizeProviderId(profileById.get(profileId)?.providerId);
				if (providerId && byProviderId.has(providerId)) {
					selectedByAgent[agentId] = providerId;
				}
			}
		}
	} catch {
		selectedByAgent = {};
	}

	return { providers: [...byProviderId.values()], selectedByAgent };
}

/**
 * One-time, idempotent conversion of a legacy single-file `board.json` into the
 * sharded form (per-task files + layout manifest). The cheap {@link boardNeedsSharding}
 * check avoids taking the workspace lock once a board is already sharded; the
 * conversion itself runs under the lock and re-checks, so concurrent loaders cannot
 * race. Runs after the legacy-home copy so machine-rooted boards are sharded too.
 */
async function migrateWorkspaceBoardToShards(repoPath: string, workspaceId: string): Promise<void> {
	const boardDir = getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId);
	const legacyBoardDir = getLegacyWorkspaceDirectoryPath(workspaceId);
	if (!(await boardNeedsSharding(boardDir, legacyBoardDir))) {
		return;
	}
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		await convertBoardToShards(boardDir, legacyBoardDir);
	});
}

export async function loadWorkspaceContextById(workspaceId: string): Promise<RuntimeWorkspaceContext | null> {
	const index = await readWorkspaceIndex();
	const entry = index.entries[workspaceId];
	if (!entry) {
		return null;
	}
	try {
		return await loadWorkspaceContext(entry.repoPath);
	} catch {
		return null;
	}
}

export async function listWorkspaceIndexEntries(): Promise<RuntimeWorkspaceIndexEntry[]> {
	const index = await readWorkspaceIndex();
	return Object.values(index.entries)
		.map((entry) => ({
			workspaceId: entry.workspaceId,
			repoPath: entry.repoPath,
		}))
		.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
}

export async function removeWorkspaceIndexEntry(workspaceId: string): Promise<boolean> {
	return await lockedFileSystem.withLock(getWorkspaceIndexLockRequest(), async () => {
		const index = await readWorkspaceIndex();
		const entry = index.entries[workspaceId];
		if (!entry) {
			return false;
		}
		delete index.entries[workspaceId];
		delete index.repoPathToId[entry.repoPath];
		await writeWorkspaceIndex(index);
		return true;
	});
}

export async function removeWorkspaceStateFiles(repoPath: string, workspaceId: string): Promise<void> {
	await lockedFileSystem.withLocks(
		[getWorkspacesRootLockRequest(repoPath), getWorkspaceDirectoryLockRequest(repoPath, workspaceId)],
		async () => {
			await rm(getWorkspaceDirectoryPath(repoPath, workspaceId), {
				recursive: true,
				force: true,
			});
		},
	);
}

export async function loadWorkspaceState(cwd: string): Promise<RuntimeWorkspaceStateResponse> {
	const context = await loadWorkspaceContext(cwd);
	const board = await readWorkspaceBoard(context.repoPath, context.workspaceId);
	const sessions = await readWorkspaceSessions(context.repoPath, context.workspaceId);
	const meta = await readWorkspaceMeta(context.repoPath, context.workspaceId);
	return toWorkspaceStateResponse(context, board, sessions, meta.revision);
}

export async function saveWorkspaceState(
	cwd: string,
	payload: RuntimeWorkspaceStateSaveRequest,
): Promise<RuntimeWorkspaceStateResponse> {
	const parsedPayload = parseWorkspaceStateSavePayload(payload);
	const context = await loadWorkspaceContext(cwd);
	const { repoPath, workspaceId } = context;
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const metaPath = getWorkspaceMetaPath(repoPath, workspaceId);
		const currentMeta = await readWorkspaceMeta(repoPath, workspaceId);
		const expectedRevision = parsedPayload.expectedRevision;
		if (
			typeof expectedRevision === "number" &&
			Number.isInteger(expectedRevision) &&
			expectedRevision >= 0 &&
			expectedRevision !== currentMeta.revision
		) {
			throw new WorkspaceStateConflictError(expectedRevision, currentMeta.revision);
		}
		const board = parsedPayload.board;
		const sessions = parsedPayload.sessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await saveShardedBoard(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), board);
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(repoPath, workspaceId), sessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, board, sessions, nextRevision);
	});
}

export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceAtomicMutationResponse<T> {
	value: T;
	state: RuntimeWorkspaceStateResponse;
	saved: boolean;
}

export async function mutateWorkspaceState<T>(
	cwd: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
	const context = await loadWorkspaceContext(cwd);
	const { repoPath, workspaceId } = context;
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const currentBoard = await readWorkspaceBoard(repoPath, workspaceId);
		const currentSessions = await readWorkspaceSessions(repoPath, workspaceId);
		const currentMeta = await readWorkspaceMeta(repoPath, workspaceId);
		const currentState = toWorkspaceStateResponse(context, currentBoard, currentSessions, currentMeta.revision);

		const mutation = mutate(currentState);
		if (mutation.save === false) {
			return {
				value: mutation.value,
				state: currentState,
				saved: false,
			};
		}

		const nextBoard = mutation.board;
		const nextSessions = mutation.sessions ?? currentSessions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await saveShardedBoard(getBoardDataWorkspaceDirectoryPath(repoPath, workspaceId), nextBoard);
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(repoPath, workspaceId), nextSessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(repoPath, workspaceId), nextMeta, {
			lock: null,
		});

		return {
			value: mutation.value,
			state: toWorkspaceStateResponse(context, nextBoard, nextSessions, nextRevision),
			saved: true,
		};
	});
}
