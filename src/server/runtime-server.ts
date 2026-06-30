import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { handleMcpOauthCallback } from "../agent-sdk/kanban/mcp-runtime-service";
import {
	createInMemoryPiTaskSessionService,
	type PiTaskSessionService,
} from "../agent-sdk/kanban/pi-task-session-service";
import type {
	RuntimeCommandRunResponse,
	RuntimeRunUpdateResponse,
	RuntimeUpdateStatusResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { parseHomeAgentSessionId } from "../core/home-agent-session";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimePrimaryAccessUrl,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
import { findOpenTasksForOriginThread } from "../core/task-board-mutations";
import {
	checkRateLimit,
	clearRateLimit,
	extractBearerToken,
	extractSessionTokenFromCookie,
	isPasscodeEnabled,
	issueSession,
	recordFailedAttempt,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../security/passcode-manager";
import { createWorkspaceHomeThreadStore, type HomeThreadStore } from "../session/home-thread-store";
import { FileSessionMessageJournal } from "../session/session-message-journal";
import {
	getWorkspaceSessionMessagesDirPath,
	invalidateWorkspaceBoardCache,
	loadWorkspaceBoardById,
	loadWorkspaceContextById,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createDbApi } from "../trpc/db-api";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi } from "../trpc/runtime-api";
import { type BoardSyncApi, createWorkspaceApi } from "../trpc/workspace-api";
import { type BoardSyncService, createBoardSyncService } from "../workspace/board-sync";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
import { markStall } from "./event-loop-stall-watchdog";
import { handleHttpRequest, handleSocketUpgrade } from "./middleware";
import type { RuntimeStateHub } from "./runtime-state-hub";
import type { WorkspaceRegistry } from "./workspace-registry";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => Promise<boolean>;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeWorkspaceStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => Promise<string | null>;
	getUpdateStatus: () => RuntimeUpdateStatusResponse;
	runUpdateNow: () => Promise<RuntimeRunUpdateResponse>;
}

export interface RuntimeServer {
	url: string;
	close: () => Promise<void>;
}

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	// Bun 1.3.x (JavaScriptCore) busy-waits the event loop when the only
	// pending work is an unresolved Promise (e.g. PTY child process
	// `bunProc.exited`) — even with active I/O watchers. The pi agent loop
	// installs its own keepalive while running, but CLI/terminal agent
	// sessions have no such protection. A short-interval ref'd timer keeps
	// the event loop blocked in epoll_wait. Cleared in close() so it does
	// not prevent graceful shutdown.
	const eventLoopKeepaliveTimer = setInterval(() => {}, 1_000);

	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);

	// Pi task session service management
	const piTaskSessionServiceByWorkspaceId = new Map<string, PiTaskSessionService>();
	const getScopedPiTaskSessionService = async (scope: RuntimeTrpcWorkspaceScope): Promise<PiTaskSessionService> => {
		let service = piTaskSessionServiceByWorkspaceId.get(scope.workspaceId);
		if (!service) {
			service = createInMemoryPiTaskSessionService({
				messageJournal: new FileSessionMessageJournal({
					sessionsDir: getWorkspaceSessionMessagesDirPath(scope.workspacePath, scope.workspaceId),
				}),
			});
			piTaskSessionServiceByWorkspaceId.set(scope.workspaceId, service);
			deps.runtimeStateHub.trackPiTaskSessionService(scope.workspaceId, scope.workspacePath, service);
		}
		return service;
	};
	const disposePiTaskSessionServiceAsync = async (workspaceId: string): Promise<void> => {
		const service = piTaskSessionServiceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		piTaskSessionServiceByWorkspaceId.delete(workspaceId);
		await service.dispose();
	};
	const disposePiTaskSessionService = (workspaceId: string): void => {
		void disposePiTaskSessionServiceAsync(workspaceId);
	};

	// Home chat thread registry management. One store per workspace; closing a
	// thread cleans up its backing session via the matching session manager.
	const homeThreadStoreByWorkspaceId = new Map<string, HomeThreadStore>();
	const getScopedHomeThreadStore = (scope: RuntimeTrpcWorkspaceScope): HomeThreadStore => {
		let store = homeThreadStoreByWorkspaceId.get(scope.workspaceId);
		if (!store) {
			store = createWorkspaceHomeThreadStore(scope.workspaceId, {
				// Block a hard close while the thread still has unfinished tasks it
				// originated (any task in a non-terminal column). Reads the live board so
				// the check reflects the current column of each task.
				getOpenOriginTasks: async (threadId) => {
					const board = await loadWorkspaceBoardById(scope.workspaceId);
					return findOpenTasksForOriginThread(board, threadId).map((card) => ({
						id: card.id,
						title: card.title,
					}));
				},
				onCloseSession: async (sessionId) => {
					// Route cleanup to the agent that actually backs the session, so
					// closing a thread never lazily spins up the other manager.
					const parts = parseHomeAgentSessionId(sessionId);
					if (parts?.agentId === "pi") {
						await piTaskSessionServiceByWorkspaceId.get(scope.workspaceId)?.closeTaskSession(sessionId);
						return;
					}
					await deps.workspaceRegistry
						.getTerminalManagerForWorkspace(scope.workspaceId)
						?.closeTaskSession(sessionId);
				},
			});
			homeThreadStoreByWorkspaceId.set(scope.workspaceId, store);
		}
		return store;
	};
	const disposeHomeThreadStore = (workspaceId: string): void => {
		homeThreadStoreByWorkspaceId.delete(workspaceId);
	};

	// Board-branch decoupling: after each committed-data change the board worktree is
	// (debounced) committed **locally** — push and pull are explicit, user-only actions, so
	// the hot path never touches the network. A no-op for repos that have not activated
	// decoupling (no `.kanban/board-ref`).
	const boardSyncService: BoardSyncService = createBoardSyncService({
		broadcastWorkspaceState: (workspaceId, workspacePath) => {
			// board-sync only broadcasts after a pull/adopt rewrote the board worktree's
			// task shards — an out-of-process change that does NOT bump the machine-local
			// `meta.revision`. Bust the revision-keyed board memo first so this very
			// broadcast reflects the pulled state instead of the cached pre-pull board.
			// (`workspacePath` is the repo root, i.e. the board cache's repoPath key.)
			invalidateWorkspaceBoardCache(workspacePath, workspaceId);
			return deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
		},
		// Push the recomputed status to the workspace's clients (the top-bar badge) on every
		// transition, so the UI stays live without polling.
		onStatusChanged: (target, status) => {
			deps.runtimeStateHub.broadcastBoardSyncStatusUpdated(target.workspaceId, status);
		},
	});
	// Board sync operations exposed to the tRPC workspace API. `workspacePath` is the repo
	// root, which is also the board sync target's `repoPath`.
	const boardSyncApi: BoardSyncApi = {
		getStatus: (scope) =>
			boardSyncService.getStatus({
				repoPath: scope.workspacePath,
				workspaceId: scope.workspaceId,
				workspacePath: scope.workspacePath,
			}),
		runAction: (scope, action) => {
			const target = {
				repoPath: scope.workspacePath,
				workspaceId: scope.workspaceId,
				workspacePath: scope.workspacePath,
			};
			return action === "push" ? boardSyncService.pushNow(target) : boardSyncService.pullNow(target);
		},
		setAutoSyncPaused: (scope, paused) =>
			boardSyncService.setAutoSyncPaused(
				{ repoPath: scope.workspacePath, workspaceId: scope.workspaceId, workspacePath: scope.workspacePath },
				paused,
			),
		renameBranch: (scope, branch) =>
			boardSyncService.renameBranch(
				{ repoPath: scope.workspacePath, workspaceId: scope.workspaceId, workspacePath: scope.workspacePath },
				branch,
			),
	};
	// Wrap the state broadcast so every committed-data mutation (board, vault, files,
	// providers, threads — server-side writes and the CLI's notifyStateUpdated alike)
	// also schedules a board sync. The schedule fires regardless of connected clients,
	// unlike the broadcast itself. `workspacePath` is the repo root.
	const broadcastWorkspaceStateAndSyncBoard = (workspaceId: string, workspacePath: string): Promise<void> | void => {
		const result = deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
		boardSyncService.scheduleSync({ repoPath: workspacePath, workspaceId, workspacePath });
		return result;
	};

	// One DB API for the whole server lifetime: it owns a process-wide PoolManager that
	// reuses one live driver per connection across requests, so it must NOT be rebuilt
	// per request (createTrpcContext runs per request). Its methods take the workspace
	// scope explicitly and hold no per-request state, so a single instance is reused.
	const dbApi = createDbApi();

	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		for (const workspaceId of piTaskSessionServiceByWorkspaceId.keys()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			await disposePiTaskSessionServiceAsync(workspaceId);
			disposeHomeThreadStore(workspaceId);
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			runtimeApi: createRuntimeApi({
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
				getScopedTerminalManager,
				getScopedPiTaskSessionService,
				getScopedHomeThreadStore,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				runCommand: deps.runCommand,
				broadcastKanbanMcpAuthStatusesUpdated: deps.runtimeStateHub.broadcastKanbanMcpAuthStatusesUpdated,
				broadcastTaskChatCleared: deps.runtimeStateHub.broadcastTaskChatCleared,
				bumpKanbanSessionContextVersion: deps.runtimeStateHub.bumpKanbanSessionContextVersion,
				prepareForStateReset,
				getUpdateStatus: deps.getUpdateStatus,
				runUpdateNow: deps.runUpdateNow,
			}),
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				getScopedPiTaskSessionService,
				broadcastRuntimeWorkspaceStateUpdated: broadcastWorkspaceStateAndSyncBoard,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
				boardSync: boardSyncApi,
			}),
			dbApi,
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				getTerminalManagerForWorkspace: deps.workspaceRegistry.getTerminalManagerForWorkspace,
				disposeWorkspace: (workspaceId, options) => {
					disposePiTaskSessionService(workspaceId);
					disposeHomeThreadStore(workspaceId);
					return deps.disposeWorkspace(workspaceId, options);
				},
				collectProjectWorktreeTaskIdsForRemoval: deps.collectProjectWorktreeTaskIdsForRemoval,
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
				serverCwd: process.cwd(),
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: broadcastWorkspaceStateAndSyncBoard,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
			}),
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const isRemoteMode = isKanbanRemoteHost();

	const readRequestBody = (req: IncomingMessage, maxBytes = 4096): Promise<string> =>
		new Promise((resolve, reject) => {
			let body = "";
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxBytes) {
					reject(new Error("Request body too large"));
					return;
				}
				body += chunk.toString("utf8");
			});
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});

	const getRemoteIp = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

	const tlsConfig = getKanbanRuntimeTls();
	const requestHandler = async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
		try {
			if (handleHttpRequest(req, res).end) {
				return;
			}

			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);

			// ── Passcode gate (remote mode only) ──────────────────────────────
			const passcodeActive = isRemoteMode && isPasscodeEnabled();
			if (pathname === "/api/passcode/status") {
				if (passcodeActive) {
					const token = extractSessionTokenFromCookie(req.headers.cookie);
					const authenticated = token !== null && validateSession(token);
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: true, authenticated }));
				} else {
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ required: false, authenticated: true }));
				}
				return;
			}
			if (passcodeActive && req.method === "POST" && pathname === "/api/passcode/verify") {
				const ip = getRemoteIp(req);
				const rateLimit = checkRateLimit(ip);
				if (!rateLimit.allowed) {
					const retryAfterSec = rateLimit.lockedUntilMs
						? Math.ceil((rateLimit.lockedUntilMs - Date.now()) / 1000)
						: 30;
					res.writeHead(429, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"Retry-After": String(retryAfterSec),
					});
					res.end(JSON.stringify({ error: "Too many attempts. Please wait before trying again." }));
					return;
				}
				let body: string;
				try {
					body = await readRequestBody(req);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid request body." }));
					return;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(body);
				} catch {
					res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "Invalid JSON." }));
					return;
				}
				const submitted =
					parsed !== null &&
					typeof parsed === "object" &&
					"passcode" in parsed &&
					typeof (parsed as Record<string, unknown>).passcode === "string"
						? ((parsed as Record<string, unknown>).passcode as string)
						: "";
				if (!validatePasscode(submitted)) {
					recordFailedAttempt(ip);
					res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ error: "Invalid passcode." }));
					return;
				}
				clearRateLimit(ip);
				const token = issueSession();
				const cookieFlags = [
					`kanban_session=${token}`,
					"HttpOnly",
					"SameSite=Strict",
					"Path=/",
					`Max-Age=${24 * 60 * 60}`,
					...(tlsConfig !== null ? ["Secure"] : []),
				].join("; ");
				res.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": cookieFlags,
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (passcodeActive) {
				// Check session cookie (browser flow) first, then internal bearer token (CLI flow).
				const sessionToken = extractSessionTokenFromCookie(req.headers.cookie);
				const sessionAuth = sessionToken !== null && validateSession(sessionToken);
				const bearerToken = extractBearerToken(req.headers.authorization);
				const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
				const authenticated = sessionAuth || internalAuth;
				if (!authenticated) {
					// Static assets (JS, CSS, images, fonts, icons, manifest) are served
					// freely even when unauthenticated. They contain no user data and are
					// required for the React app to boot and render the passcode gate.
					// Only API routes are hard-blocked; index.html is served normally so
					// PasscodeGateProvider in React can intercept before any API calls.
					if (pathname.startsWith("/api/")) {
						res.writeHead(401, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						res.end(JSON.stringify({ error: "Authentication required." }));
						return;
					}
					// Fall through — let the normal asset/index.html serving below handle it.
					// PasscodeGateProvider in main.tsx will render the gate before any
					// authenticated API calls are made.
				}
			}
			// ── End passcode gate ──────────────────────────────────────────────

			const oauthCallbackResponse = await handleMcpOauthCallback(requestUrl);
			if (oauthCallbackResponse) {
				res.writeHead(oauthCallbackResponse.statusCode, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(oauthCallbackResponse.body);
				return;
			}
			if (pathname.startsWith("/api/trpc")) {
				// Breadcrumb for the stall watchdog: if a tRPC handler hangs the event
				// loop, the watchdog report names the procedure path.
				markStall("trpc", pathname.slice("/api/trpc/".length) || pathname);
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname.startsWith("/api/")) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	};
	const server = tlsConfig
		? createHttpsServer({ key: tlsConfig.key, cert: tlsConfig.cert }, requestHandler)
		: createServer(requestHandler);
	server.on("upgrade", (request, socket, head) => {
		if (handleSocketUpgrade(request, socket).end) {
			return;
		}

		let requestUrl: URL;
		try {
			requestUrl = new URL(request.url ?? "/", getKanbanRuntimeOrigin());
		} catch {
			socket.destroy();
			return;
		}
		if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
			return;
		}
		// ── Passcode gate for WebSocket upgrades (remote mode only) ──────────
		const passcodeActive = isRemoteMode && isPasscodeEnabled();
		if (passcodeActive) {
			const sessionToken = extractSessionTokenFromCookie(request.headers.cookie);
			const sessionAuth = sessionToken !== null && validateSession(sessionToken);
			const bearerToken = extractBearerToken(request.headers.authorization);
			const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
			if (!sessionAuth && !internalAuth) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
		}
		// ── End passcode gate ─────────────────────────────────────────────────
		(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
		const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
		deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId });
	});
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		server,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
		validateUpgradeSession:
			isRemoteMode && isPasscodeEnabled()
				? (cookieHeader) => {
						const token = extractSessionTokenFromCookie(cookieHeader);
						return token !== null && validateSession(token);
					}
				: undefined,
	});
	server.on("upgrade", (request, socket) => {
		const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
		if (handled) {
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Failed to start local server.");
	}
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? getKanbanRuntimePrimaryAccessUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimePrimaryAccessUrl();

	// No boot reconcile: per the board-sync redesign (auto commit + explicit push/pull,
	// `.plan/docs/board-sync-redesign.md`) startup never touches the network. The badge
	// shows the last-known (fetch-free) ahead/behind; the user pulls explicitly to refresh
	// it. This also removes the "remote has no board branch" boot fetch failure on Windows.

	return {
		url,
		close: async () => {
			// Release the event-loop keepalive so the process can exit cleanly.
			clearInterval(eventLoopKeepaliveTimer);
			// Flush a final local board commit (covers the shutdown coordinator's last
			// interrupted-session save) before tearing down the broadcast channel. No push —
			// unpushed commits stay durable locally for the user to Push next session.
			await boardSyncService.dispose();
			await Promise.all(
				Array.from(piTaskSessionServiceByWorkspaceId.values()).map(async (service) => {
					await service.dispose();
				}),
			);
			piTaskSessionServiceByWorkspaceId.clear();
			homeThreadStoreByWorkspaceId.clear();
			await deps.runtimeStateHub.close();
			await terminalWebSocketBridge.close();
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}
