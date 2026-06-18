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
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTls,
	isKanbanRemoteHost,
} from "../core/runtime-endpoint";
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
import { deliverPromptToHomeSession } from "../session/home-session-delivery";
import { createWorkspaceHomeThreadStore, type HomeThreadStore } from "../session/home-thread-store";
import { FileSessionMessageJournal } from "../session/session-message-journal";
import { SessionTakeoverCoordinator, type TakeoverTarget } from "../session/session-takeover";
import {
	getWorkspaceSessionMessagesDirPath,
	loadWorkspaceBoardById,
	loadWorkspaceContextById,
	loadWorkspaceHomeThreads,
	resolveRepoPathForWorkspaceId,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createTerminalWebSocketBridge } from "../terminal/ws-server";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router";
import { createHooksApi } from "../trpc/hooks-api";
import { createProjectsApi } from "../trpc/projects-api";
import { createRuntimeApi, launchHomeAgentSession } from "../trpc/runtime-api";
import { type BoardSyncApi, createWorkspaceApi } from "../trpc/workspace-api";
import { type BoardSyncService, createBoardSyncService } from "../workspace/board-sync";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets";
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
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeWorkspaceStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => string | null;
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

	// In-process takeover hook (decision 43f28): when a task created from a home
	// thread transitions (plan-ready / review / failure), and that thread's takeover
	// switch is on, render the event into a prompt and inject it back into the
	// originating home session. No websocket — the runtime state hub forwards every
	// session-summary update here. Targeting and delivery I/O are injected so the
	// coordinator stays pure; failures are logged, never thrown.
	const launchHomeSessionDeps = {
		getScopedPiTaskSessionService,
		getScopedTerminalManager,
		loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
	};
	const sessionTakeoverCoordinator = new SessionTakeoverCoordinator({
		resolveTarget: async (workspaceId, taskId): Promise<TakeoverTarget | null> => {
			const board = await loadWorkspaceBoardById(workspaceId);
			let originSessionId: string | undefined;
			for (const column of board.columns) {
				const card = column.cards.find((entry) => entry.id === taskId);
				if (card) {
					originSessionId = card.originHomeSessionId;
					break;
				}
			}
			if (!originSessionId) {
				return null;
			}
			const parts = parseHomeAgentSessionId(originSessionId);
			if (!parts) {
				return null;
			}
			const { threads } = await loadWorkspaceHomeThreads(workspaceId);
			// The default thread is synthetic (not a registry entry), so only explicitly
			// created threads can carry a takeover switch — an unmatched id stays off.
			const thread = threads.find((entry) => entry.id === parts.threadId);
			if (!thread?.takeoverEnabled) {
				return null;
			}
			return { sessionId: originSessionId, extension: thread.takeoverExtension ?? null };
		},
		deliver: async (sessionId, prompt) => {
			const parts = parseHomeAgentSessionId(sessionId);
			if (!parts) {
				return;
			}
			const workspacePath = await resolveRepoPathForWorkspaceId(parts.workspaceId);
			if (!workspacePath) {
				return;
			}
			const scope: RuntimeTrpcWorkspaceScope = { workspaceId: parts.workspaceId, workspacePath };
			const piService = await getScopedPiTaskSessionService(scope);
			const terminalManager = await getScopedTerminalManager(scope);
			await deliverPromptToHomeSession(
				{
					piService,
					terminalManager,
					launch: (sid, text) => launchHomeAgentSession(scope, sid, text, launchHomeSessionDeps),
				},
				sessionId,
				prompt,
			);
		},
	});
	deps.runtimeStateHub.registerTaskSessionSummaryObserver((workspaceId, summary) => {
		sessionTakeoverCoordinator.handleSummary(workspaceId, summary);
	});

	// Board-branch decoupling: after each committed-data change the board worktree is
	// committed + (debounced) pushed; on boot it is fast-forwarded from the remote. A
	// no-op for repos that have not activated decoupling (no `.kanban/board-ref`).
	const boardSyncService: BoardSyncService = createBoardSyncService({
		broadcastWorkspaceState: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
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
	const activeWorkspacePath = deps.workspaceRegistry.getActiveWorkspacePath();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	// Reconcile the active workspace's board branch against its remote at boot so it
	// reflects edits another machine pushed while this one was offline. Fire-and-forget
	// so a slow fetch never delays server start; it rebroadcasts if it pulls anything.
	if (activeWorkspaceId && activeWorkspacePath) {
		void boardSyncService.syncOnStartup({
			repoPath: activeWorkspacePath,
			workspaceId: activeWorkspaceId,
			workspacePath: activeWorkspacePath,
		});
	}

	return {
		url,
		close: async () => {
			// Flush a final board commit + push (covers the shutdown coordinator's last
			// interrupted-session save) before tearing down the broadcast channel.
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
