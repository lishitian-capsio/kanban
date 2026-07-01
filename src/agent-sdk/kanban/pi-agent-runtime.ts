// Agent lifecycle manager for pi agent sessions.
import type {
	RuntimeReasoningEffort,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "../../core/api-contract";
import { Agent } from "../agent";
import type { AgentEvent, AgentMessage, AgentTool } from "../types";
import { extractErrorFromMessages, extractFinalAssistantText } from "./pi-event-adapter";
import {
	type PiMcpRuntimeService,
	type PiMcpToolBundle,
	createPiMcpRuntimeService,
} from "./pi-mcp-integration";
import {
	type PiLaunchConfig,
	type PiResolvedModel,
	resolvePiModel,
	toOmpEffort,
} from "./pi-provider-config";
import { createPiSubagentSessionId } from "./pi-subagent-session-id";
import {
	type PiToolApprovalRequest,
	type PiToolApprovalResult,
	type SpawnSubagentRequest,
	type SpawnSubagentResult,
	buildPiToolSet,
	createPiToolApprovalHook,
} from "./pi-tools-bridge";
import { type BuildPiSystemPromptInput, buildPiSystemPrompt } from "./pi-system-prompt";

export interface StartPiSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	taskTitle?: string;
	images?: RuntimeTaskImage[];
	providerId?: string | null;
	modelId?: string | null;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeReasoningEffort | null;
	systemPrompt?: string | null;
	startInPlanMode?: boolean;
	requestToolApproval?: (request: PiToolApprovalRequest) => Promise<PiToolApprovalResult>;
}

/** Everything needed to spawn a child (subagent) Agent that mirrors the parent's config. */
interface PiSubagentSpawnContext {
	cwd: string;
	/** The parent's resolved omp model object (reused unless the `task` call overrides it). */
	model: PiResolvedModel["model"];
	/** Provider + baseUrl to re-resolve the model when the `task` call passes a `model` override. */
	providerId: string;
	baseUrl: string | null;
	systemPrompt: string;
	getApiKey: (() => string | undefined) | undefined;
	beforeToolCall: ReturnType<typeof createPiToolApprovalHook>;
	effort: ReturnType<typeof toOmpEffort>;
	/** The parent's MCP extra tools, shared with children (no re-dial). */
	extraTools: AgentTool<any>[];
	requestToolApproval?: (request: PiToolApprovalRequest) => Promise<PiToolApprovalResult>;
}

export interface PiAgentSession {
	agent: Agent;
	taskId: string;
	providerId: string;
	modelId: string;
	mode: RuntimeTaskSessionMode;
	/** Live child (subagent) Agents keyed by subagentId, for cancellation/cleanup. */
	childAgents: Map<string, Agent>;
	/** Captured config for spawning children. */
	spawnContext: PiSubagentSpawnContext;
	dispose: () => Promise<void>;
}

/** Metadata passed alongside each forwarded subagent event so the service can project it. */
export interface PiSubagentEventInfo {
	parentTaskId: string;
	subagentId: string;
	compositeId: string;
	label: string;
	modelId: string | null;
}

export interface PiAgentRuntime {
	startSession(request: StartPiSessionRequest): Promise<PiAgentSession>;
	sendInput(taskId: string, text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<void>;
	stopSession(taskId: string): Promise<void>;
	abortSession(taskId: string): Promise<void>;
	clearSessions(taskId: string): Promise<void>;
	getSession(taskId: string): PiAgentSession | null;
	dispose(): Promise<void>;
	subscribeToEvents(taskId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface CreatePiAgentRuntimeOptions {
	onTaskEvent?: (taskId: string, event: AgentEvent) => void;
	/** Forwarded for every event emitted by a child (subagent) Agent, tagged with its identity. */
	onSubagentEvent?: (info: PiSubagentEventInfo, event: AgentEvent) => void;
	createMcpRuntimeService?: () => PiMcpRuntimeService;
}

/**
 * In-memory pi agent runtime that manages Agent instances per task.
 */
export class InMemoryPiAgentRuntime implements PiAgentRuntime {
	private readonly sessions = new Map<string, PiAgentSession>();
	private readonly eventListeners = new Map<string, Set<(event: AgentEvent) => void>>();
	private readonly mcpRuntimeService: PiMcpRuntimeService;
	private readonly onTaskEvent: ((taskId: string, event: AgentEvent) => void) | null;
	private readonly onSubagentEvent: ((info: PiSubagentEventInfo, event: AgentEvent) => void) | null;

	constructor(options: CreatePiAgentRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
		this.onSubagentEvent = options.onSubagentEvent ?? null;
		this.mcpRuntimeService = (options.createMcpRuntimeService ?? createPiMcpRuntimeService)();
	}

	async startSession(request: StartPiSessionRequest): Promise<PiAgentSession> {
		// Dispose existing session for this task
		await this.disposeSession(request.taskId);

		const resolved = resolvePiModel(request.providerId, request.modelId, request.baseUrl);
		const resolvedMode: RuntimeTaskSessionMode = request.mode ?? "act";

		// Build tools
		let mcpToolBundle: PiMcpToolBundle | null = null;
		try {
			mcpToolBundle = await this.mcpRuntimeService.createToolBundle();
		} catch {
			mcpToolBundle = null;
		}

		const extraTools = mcpToolBundle?.tools ?? [];
		const tools = buildPiToolSet({
			cwd: request.cwd,
			extraTools,
			onToolApproval: request.requestToolApproval,
			// The `task` tool delegates to a child Agent that mirrors this session's config.
			spawnSubagent: (spawnRequest) => this.spawnChild(request.taskId, spawnRequest),
		});

		// Build system prompt
		const systemPrompt =
			request.systemPrompt?.trim() ||
			buildPiSystemPrompt({
				cwd: request.cwd,
				mode: resolvedMode,
				startInPlanMode: request.startInPlanMode,
			});

		const getApiKey = request.apiKey ? () => request.apiKey ?? undefined : undefined;
		const beforeToolCall = createPiToolApprovalHook(request.requestToolApproval);
		const effort = toOmpEffort(request.reasoningEffort);

		// Create Agent instance.
		//
		// A minimal telemetry config is supplied purely to activate the run
		// collector so the per-run token usage rollup rides along on the
		// `agent_end` event (consumed by the pi event adapter for the session's
		// cumulative token total). No OTEL SDK is registered, so the tracer is a
		// no-op and span calls are cheap pass-throughs; content capture is left
		// off to avoid serializing message payloads we never export.
		const agent = new Agent({
			initialState: {
				systemPrompt: [systemPrompt],
				model: resolved.model,
				tools,
			},
			getApiKey,
			beforeToolCall,
			telemetry: { captureMessageContent: false },
		});

		// Set thinking level from reasoning effort
		if (effort) {
			agent.setThinkingLevel(effort);
		}

		const childAgents = new Map<string, Agent>();
		const session: PiAgentSession = {
			agent,
			taskId: request.taskId,
			providerId: resolved.provider,
			modelId: resolved.modelId,
			mode: resolvedMode,
			childAgents,
			spawnContext: {
				cwd: request.cwd,
				model: resolved.model,
				providerId: resolved.provider,
				baseUrl: request.baseUrl ?? null,
				systemPrompt,
				getApiKey,
				beforeToolCall,
				effort,
				extraTools,
				requestToolApproval: request.requestToolApproval,
			},
			dispose: async () => {
				agent.abort();
				for (const child of childAgents.values()) {
					child.abort();
				}
				childAgents.clear();
				await mcpToolBundle?.dispose();
			},
		};

		this.sessions.set(request.taskId, session);

		// Subscribe to events and forward
		agent.subscribe((event: AgentEvent) => {
			this.onTaskEvent?.(request.taskId, event);
			const listeners = this.eventListeners.get(request.taskId);
			if (listeners) {
				for (const listener of listeners) {
					listener(event);
				}
			}
		});

		// Start the initial prompt if provided
		const normalizedPrompt = request.prompt.trim();
		if (normalizedPrompt.length > 0) {
			const userMessage = buildUserMessage(normalizedPrompt, request.images);
			// Fire and forget - events will be emitted via subscription
			void agent.prompt(userMessage).catch(() => {
				// Errors are surfaced via agent_end event
			});
		}

		return session;
	}

	/**
	 * Spawn a child (subagent) Agent that mirrors the parent session's config, run it to
	 * completion on `request.prompt`, and return its final text as the `task` tool result.
	 * The child's events are forwarded (tagged with subagent identity) via `onSubagentEvent`.
	 * Children get NO `task` tool of their own (depth-1) and abort when the parent turn's
	 * signal aborts (or the parent session is disposed).
	 */
	private async spawnChild(parentTaskId: string, request: SpawnSubagentRequest): Promise<SpawnSubagentResult> {
		const session = this.sessions.get(parentTaskId);
		if (!session) {
			return { finalText: "Subagent could not start: parent session is no longer active.", isError: true };
		}
		const ctx = session.spawnContext;
		const compositeId = createPiSubagentSessionId(parentTaskId, request.subagentId);
		const model = request.modelOverride
			? resolvePiModel(ctx.providerId, request.modelOverride, ctx.baseUrl).model
			: ctx.model;
		const modelId = request.modelOverride ?? session.modelId;

		const child = new Agent({
			initialState: {
				systemPrompt: [ctx.systemPrompt],
				model,
				// No spawnSubagent → the child has no `task` tool (depth-1 subagents only).
				tools: buildPiToolSet({
					cwd: ctx.cwd,
					extraTools: ctx.extraTools,
					onToolApproval: ctx.requestToolApproval,
				}),
			},
			getApiKey: ctx.getApiKey,
			beforeToolCall: ctx.beforeToolCall,
			telemetry: { captureMessageContent: false },
		});
		if (ctx.effort) {
			child.setThinkingLevel(ctx.effort);
		}

		session.childAgents.set(request.subagentId, child);
		const info: PiSubagentEventInfo = {
			parentTaskId,
			subagentId: request.subagentId,
			compositeId,
			label: request.label,
			modelId,
		};

		let finalText = "";
		let isError = false;
		const unsubscribe = child.subscribe((event: AgentEvent) => {
			this.onSubagentEvent?.(info, event);
			if (event.type === "agent_end") {
				finalText = extractFinalAssistantText(event.messages) ?? "";
				if (extractErrorFromMessages(event.messages)) {
					isError = true;
				}
			}
		});

		const onAbort = () => child.abort();
		request.signal?.addEventListener("abort", onAbort);

		try {
			await child.prompt(buildUserMessage(request.prompt));
			return { finalText, isError };
		} catch (error) {
			return { finalText: error instanceof Error ? error.message : String(error), isError: true };
		} finally {
			request.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
			child.abort();
			session.childAgents.delete(request.subagentId);
		}
	}

	async sendInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) {
			throw new Error(`No active pi session for task ${taskId}`);
		}

		const userMessage = buildUserMessage(text, images);

		if (session.agent.state.isStreaming) {
			// Queue as steering message
			session.agent.steer(userMessage);
		} else {
			// Start new turn
			await session.agent.prompt(userMessage);
		}
	}

	async stopSession(taskId: string): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) return;
		this.abortChildren(session);
		session.agent.abort();
	}

	async abortSession(taskId: string): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) return;
		this.abortChildren(session);
		session.agent.abort();
	}

	private abortChildren(session: PiAgentSession): void {
		for (const child of session.childAgents.values()) {
			child.abort();
		}
	}

	async clearSessions(taskId: string): Promise<void> {
		await this.disposeSession(taskId);
	}

	getSession(taskId: string): PiAgentSession | null {
		return this.sessions.get(taskId) ?? null;
	}

	subscribeToEvents(taskId: string, listener: (event: AgentEvent) => void): () => void {
		let listeners = this.eventListeners.get(taskId);
		if (!listeners) {
			listeners = new Set();
			this.eventListeners.set(taskId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners!.delete(listener);
			if (listeners!.size === 0) {
				this.eventListeners.delete(taskId);
			}
		};
	}

	async dispose(): Promise<void> {
		const sessionIds = [...this.sessions.keys()];
		await Promise.all(sessionIds.map((id) => this.disposeSession(id)));
		await this.mcpRuntimeService.dispose();
	}

	private async disposeSession(taskId: string): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) return;
		this.sessions.delete(taskId);
		this.eventListeners.delete(taskId);
		await session.dispose();
	}
}

function buildUserMessage(text: string, images?: RuntimeTaskImage[]): AgentMessage {
	const content: Array<{ type: "text"; text: string } | { type: "image"; source: any }> = [
		{ type: "text", text },
	];

	if (images && images.length > 0) {
		for (const image of images) {
			const mimeType = image.mimeType.trim();
			const data = image.data.trim();
			if (mimeType && data) {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: mimeType,
						data,
					},
				});
			}
		}
	}

	return {
		role: "user",
		content,
		timestamp: Date.now(),
	} as AgentMessage;
}

export function createInMemoryPiAgentRuntime(options: CreatePiAgentRuntimeOptions = {}): PiAgentRuntime {
	return new InMemoryPiAgentRuntime(options);
}
