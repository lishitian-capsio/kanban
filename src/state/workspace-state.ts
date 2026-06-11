import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import {
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeGitRepositoryInfo,
	type RuntimeRequirementsData,
	type RuntimeRequirementTaskLinksData,
	type RuntimeRequirementVersionsData,
	type RuntimeTaskSessionSummary,
	type RuntimeWorkspaceStateResponse,
	type RuntimeWorkspaceStateSaveRequest,
	runtimeBoardDataSchema,
	runtimeRequirementsDataSchema,
	runtimeRequirementTaskLinksDataSchema,
	runtimeRequirementVersionsDataSchema,
	runtimeTaskSessionSummarySchema,
	runtimeWorkspaceStateSaveRequestSchema,
} from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { diffRequirementVersions } from "../core/requirement-versions";
import { updateTaskDependencies } from "../core/task-board-mutations";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";

const RUNTIME_HOME_DIR = ".kanban";
const RUNTIME_WORKTREES_DIR = "worktrees";
const WORKSPACES_DIR = "workspaces";
const INDEX_FILENAME = "index.json";
const BOARD_FILENAME = "board.json";
const SESSIONS_FILENAME = "sessions.json";
const REQUIREMENTS_FILENAME = "requirements.json";
const REQUIREMENT_VERSIONS_FILENAME = "requirement-versions.json";
const REQUIREMENT_TASK_LINKS_FILENAME = "requirement-task-links.json";
const META_FILENAME = "meta.json";
const RUNTIME_HOME_GITIGNORE_FILENAME = ".gitignore";
// Boundary between committed content and machine-local runtime/secrets inside a
// repo's `.kanban`. Denylist style: future committed directories (e.g. tasks/,
// files/) are tracked by default; only known runtime + secret paths are ignored.
const RUNTIME_HOME_GITIGNORE_CONTENT = `# Kanban runtime data boundary — see docs/superpowers/plans for rationale.
# Committed (content): workspaces/<id>/board.json, requirements*.json, and
# future tasks/ + files/. Everything below is machine-local or secret.

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
const INDEX_VERSION = 1;
const WORKSPACE_ID_COLLISION_SUFFIX_LENGTH = 4;

const BOARD_COLUMNS: Array<{ id: RuntimeBoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Done" },
];

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
}

export interface LoadWorkspaceContextOptions {
	autoCreateIfMissing?: boolean;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: BOARD_COLUMNS.map((column) => ({
			id: column.id,
			title: column.title,
			cards: [],
		})),
		dependencies: [],
	};
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

export function getTaskWorktreesHomePath(repoPath: string): string {
	return join(getRuntimeHomePath(repoPath), RUNTIME_WORKTREES_DIR);
}

export function getWorkspacesRootPath(repoPath: string): string {
	return join(getRuntimeHomePath(repoPath), WORKSPACES_DIR);
}

/** The workspace index is the cross-repo registry, so it stays machine-rooted. */
function getWorkspaceIndexPath(): string {
	return join(getMachineKanbanHomePath(), WORKSPACES_DIR, INDEX_FILENAME);
}

export function getWorkspaceDirectoryPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspacesRootPath(repoPath), workspaceId);
}

/**
 * Old machine-rooted workspace directory (`~/.kanban/workspaces/<id>`). Used as
 * the copy-migration source and the read fallback when the repo-rooted location
 * does not yet exist. Never written to.
 */
function getLegacyWorkspaceDirectoryPath(workspaceId: string): string {
	return join(getMachineKanbanHomePath(), WORKSPACES_DIR, workspaceId);
}

function getWorkspaceBoardPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), BOARD_FILENAME);
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
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENTS_FILENAME);
}

function getWorkspaceRequirementVersionsPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_VERSIONS_FILENAME);
}

function getWorkspaceRequirementTaskLinksPath(repoPath: string, workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(repoPath, workspaceId), REQUIREMENT_TASK_LINKS_FILENAME);
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
	const boardPath = getWorkspaceBoardPath(repoPath, workspaceId);
	const rawBoard = await readJsonFileWithLegacyFallback(
		boardPath,
		getLegacyWorkspaceFilePath(workspaceId, BOARD_FILENAME),
	);
	return updateTaskDependencies(
		parsePersistedStateFile(boardPath, BOARD_FILENAME, rawBoard, runtimeBoardDataSchema, createEmptyBoard()),
	);
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

async function readWorkspaceRequirements(repoPath: string, workspaceId: string): Promise<RuntimeRequirementsData> {
	const requirementsPath = getWorkspaceRequirementsPath(repoPath, workspaceId);
	const rawRequirements = await readJsonFileWithLegacyFallback(
		requirementsPath,
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENTS_FILENAME),
	);
	return parsePersistedStateFile(
		requirementsPath,
		REQUIREMENTS_FILENAME,
		rawRequirements,
		runtimeRequirementsDataSchema,
		{
			items: [],
		},
	);
}

async function readWorkspaceRequirementVersions(
	repoPath: string,
	workspaceId: string,
): Promise<RuntimeRequirementVersionsData> {
	const versionsPath = getWorkspaceRequirementVersionsPath(repoPath, workspaceId);
	const rawVersions = await readJsonFileWithLegacyFallback(
		versionsPath,
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENT_VERSIONS_FILENAME),
	);
	return parsePersistedStateFile(
		versionsPath,
		REQUIREMENT_VERSIONS_FILENAME,
		rawVersions,
		runtimeRequirementVersionsDataSchema,
		{ versions: [] },
	);
}

export async function loadWorkspaceRequirementVersions(cwd: string): Promise<RuntimeRequirementVersionsData> {
	const context = await loadWorkspaceContext(cwd);
	return await readWorkspaceRequirementVersions(context.repoPath, context.workspaceId);
}

async function readWorkspaceRequirementTaskLinks(
	repoPath: string,
	workspaceId: string,
): Promise<RuntimeRequirementTaskLinksData> {
	const linksPath = getWorkspaceRequirementTaskLinksPath(repoPath, workspaceId);
	const rawLinks = await readJsonFileWithLegacyFallback(
		linksPath,
		getLegacyWorkspaceFilePath(workspaceId, REQUIREMENT_TASK_LINKS_FILENAME),
	);
	return parsePersistedStateFile(
		linksPath,
		REQUIREMENT_TASK_LINKS_FILENAME,
		rawLinks,
		runtimeRequirementTaskLinksDataSchema,
		{ links: [] },
	);
}

export async function loadWorkspaceRequirementTaskLinks(cwd: string): Promise<RuntimeRequirementTaskLinksData> {
	const context = await loadWorkspaceContext(cwd);
	return await readWorkspaceRequirementTaskLinks(context.repoPath, context.workspaceId);
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
	requirements: RuntimeRequirementsData,
	requirementTaskLinks: RuntimeRequirementTaskLinksData,
	revision: number,
): RuntimeWorkspaceStateResponse {
	return {
		repoPath: context.repoPath,
		statePath: context.statePath,
		git: context.git,
		board,
		sessions,
		requirements,
		requirementTaskLinks,
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
		};
	});
}

/**
 * Ensure a repo's `.kanban` is ready: copy-migrate any legacy machine-rooted
 * data once, then ensure the git-boundary `.gitignore` exists. Idempotent and
 * non-destructive (never touches `~/.kanban`).
 */
async function prepareRepoRuntimeHome(repoPath: string, workspaceId: string): Promise<void> {
	await migrateWorkspaceDataFromLegacyHome(repoPath, workspaceId);
	await ensureRuntimeHomeGitignore(repoPath);
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
	const requirements = await readWorkspaceRequirements(context.repoPath, context.workspaceId);
	const requirementTaskLinks = await readWorkspaceRequirementTaskLinks(context.repoPath, context.workspaceId);
	const meta = await readWorkspaceMeta(context.repoPath, context.workspaceId);
	return toWorkspaceStateResponse(context, board, sessions, requirements, requirementTaskLinks, meta.revision);
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
		// Preserve existing requirements when a (possibly legacy) payload omits them,
		// so a board-only save never wipes the workspace's requirement items.
		const previousRequirements = await readWorkspaceRequirements(repoPath, workspaceId);
		const requirements = parsedPayload.requirements ?? previousRequirements;
		// Likewise preserve requirement<->task links when a payload omits them.
		const requirementTaskLinks =
			parsedPayload.requirementTaskLinks ?? (await readWorkspaceRequirementTaskLinks(repoPath, workspaceId));
		// Whole-snapshot saves (the web UI path) don't carry per-operation intent, so diff the
		// previous and next requirement sets to record create/update/delete versions — keeping the
		// version history complete regardless of whether edits came from the CLI or the UI.
		const previousVersions = await readWorkspaceRequirementVersions(repoPath, workspaceId);
		const nextVersions = diffRequirementVersions(previousRequirements, requirements, previousVersions, {
			source: "human",
		});
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(repoPath, workspaceId), board, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(repoPath, workspaceId), sessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceRequirementsPath(repoPath, workspaceId), requirements, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(
			getWorkspaceRequirementTaskLinksPath(repoPath, workspaceId),
			requirementTaskLinks,
			{ lock: null },
		);
		if (nextVersions !== previousVersions) {
			await lockedFileSystem.writeJsonFileAtomic(
				getWorkspaceRequirementVersionsPath(repoPath, workspaceId),
				nextVersions,
				{ lock: null },
			);
		}
		await lockedFileSystem.writeJsonFileAtomic(metaPath, nextMeta, {
			lock: null,
		});

		return toWorkspaceStateResponse(context, board, sessions, requirements, requirementTaskLinks, nextRevision);
	});
}

export interface RuntimeWorkspaceAtomicMutationResult<T> {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	requirements?: RuntimeRequirementsData;
	requirementTaskLinks?: RuntimeRequirementTaskLinksData;
	requirementVersions?: RuntimeRequirementVersionsData;
	value: T;
	save?: boolean;
}

export interface RuntimeWorkspaceMutationContext {
	requirementTaskLinks: RuntimeRequirementTaskLinksData;
	requirementVersions: RuntimeRequirementVersionsData;
}

export interface RuntimeWorkspaceAtomicMutationResponse<T> {
	value: T;
	state: RuntimeWorkspaceStateResponse;
	saved: boolean;
}

export async function mutateWorkspaceState<T>(
	cwd: string,
	mutate: (
		state: RuntimeWorkspaceStateResponse,
		context: RuntimeWorkspaceMutationContext,
	) => RuntimeWorkspaceAtomicMutationResult<T>,
): Promise<RuntimeWorkspaceAtomicMutationResponse<T>> {
	const context = await loadWorkspaceContext(cwd);
	const { repoPath, workspaceId } = context;
	return await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(repoPath, workspaceId), async () => {
		const currentBoard = await readWorkspaceBoard(repoPath, workspaceId);
		const currentSessions = await readWorkspaceSessions(repoPath, workspaceId);
		const currentRequirements = await readWorkspaceRequirements(repoPath, workspaceId);
		const currentRequirementTaskLinks = await readWorkspaceRequirementTaskLinks(repoPath, workspaceId);
		const currentRequirementVersions = await readWorkspaceRequirementVersions(repoPath, workspaceId);
		const currentMeta = await readWorkspaceMeta(repoPath, workspaceId);
		const currentState = toWorkspaceStateResponse(
			context,
			currentBoard,
			currentSessions,
			currentRequirements,
			currentRequirementTaskLinks,
			currentMeta.revision,
		);

		const mutation = mutate(currentState, {
			requirementTaskLinks: currentRequirementTaskLinks,
			requirementVersions: currentRequirementVersions,
		});
		if (mutation.save === false) {
			return {
				value: mutation.value,
				state: currentState,
				saved: false,
			};
		}

		const nextBoard = mutation.board;
		const nextSessions = mutation.sessions ?? currentSessions;
		const nextRequirements = mutation.requirements ?? currentRequirements;
		const nextRequirementTaskLinks = mutation.requirementTaskLinks ?? currentRequirementTaskLinks;
		const nextRequirementVersions = mutation.requirementVersions ?? currentRequirementVersions;
		const nextRevision = currentMeta.revision + 1;
		const nextMeta: WorkspaceStateMeta = {
			revision: nextRevision,
			updatedAt: Date.now(),
		};

		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceBoardPath(repoPath, workspaceId), nextBoard, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceSessionsPath(repoPath, workspaceId), nextSessions, {
			lock: null,
		});
		await lockedFileSystem.writeJsonFileAtomic(
			getWorkspaceRequirementsPath(repoPath, workspaceId),
			nextRequirements,
			{
				lock: null,
			},
		);
		await lockedFileSystem.writeJsonFileAtomic(
			getWorkspaceRequirementTaskLinksPath(repoPath, workspaceId),
			nextRequirementTaskLinks,
			{ lock: null },
		);
		await lockedFileSystem.writeJsonFileAtomic(
			getWorkspaceRequirementVersionsPath(repoPath, workspaceId),
			nextRequirementVersions,
			{ lock: null },
		);
		await lockedFileSystem.writeJsonFileAtomic(getWorkspaceMetaPath(repoPath, workspaceId), nextMeta, {
			lock: null,
		});

		return {
			value: mutation.value,
			state: toWorkspaceStateResponse(
				context,
				nextBoard,
				nextSessions,
				nextRequirements,
				nextRequirementTaskLinks,
				nextRevision,
			),
			saved: true,
		};
	});
}
