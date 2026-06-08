// Agent lifecycle manager for pi agent sessions.
import type {
	RuntimeReasoningEffort,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "../../core/api-contract";
import { Agent } from "../agent";
import type { AgentEvent, AgentMessage, AgentTool } from "../types";
import { applyPiAgentEvent } from "./pi-event-adapter";
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
import {
	type PiToolApprovalRequest,
	type PiToolApprovalResult,
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

export interface PiAgentSession {
	agent: Agent;
	taskId: string;
	providerId: string;
	modelId: string;
	mode: RuntimeTaskSessionMode;
	dispose: () => Promise<void>;
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

	constructor(options: CreatePiAgentRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
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

		const tools = buildPiToolSet({
			cwd: request.cwd,
			extraTools: mcpToolBundle?.tools ?? [],
			onToolApproval: request.requestToolApproval,
		});

		// Build system prompt
		const systemPrompt =
			request.systemPrompt?.trim() ||
			buildPiSystemPrompt({
				cwd: request.cwd,
				mode: resolvedMode,
				startInPlanMode: request.startInPlanMode,
			});

		// Create Agent instance
		const agent = new Agent({
			initialState: {
				systemPrompt: [systemPrompt],
				model: resolved.model,
				tools,
			},
			getApiKey: request.apiKey
				? () => request.apiKey ?? undefined
				: undefined,
			beforeToolCall: createPiToolApprovalHook(request.requestToolApproval),
		});

		// Set thinking level from reasoning effort
		const effort = toOmpEffort(request.reasoningEffort);
		if (effort) {
			agent.setThinkingLevel(effort);
		}

		const session: PiAgentSession = {
			agent,
			taskId: request.taskId,
			providerId: resolved.provider,
			modelId: resolved.modelId,
			mode: resolvedMode,
			dispose: async () => {
				agent.abort();
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
		session.agent.abort();
	}

	async abortSession(taskId: string): Promise<void> {
		const session = this.sessions.get(taskId);
		if (!session) return;
		session.agent.abort();
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
