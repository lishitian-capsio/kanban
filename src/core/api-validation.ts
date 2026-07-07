import { z } from "zod";

import {
	type RuntimeCommandRunRequest,
	type RuntimeConfigSaveRequest,
	type RuntimeDirectoryListRequest,
	type RuntimeFetchRemoteModelsRequest,
	type RuntimeGitCheckoutRequest,
	type RuntimeHomeChatFullscreenTabsSaveRequest,
	type RuntimeHomeChatThreadBindImChannelRequest,
	type RuntimeHomeChatThreadCloseRequest,
	type RuntimeHomeChatThreadCreateRequest,
	type RuntimeHomeChatThreadImChannelIdRequest,
	type RuntimeHomeChatThreadRenameRequest,
	type RuntimeHomeChatThreadSetNextStepRequest,
	type RuntimeHomeChatThreadSetTitleRequest,
	type RuntimeHookIngestRequest,
	type RuntimeImChatAddRequest,
	type RuntimeImChatRemoveRequest,
	type RuntimeKanbanMcpOAuthRequest,
	type RuntimeKanbanMcpSettingsSaveRequest,
	type RuntimeKanbanProviderModelsRequest,
	type RuntimePiImChannelBindRequest,
	type RuntimeProjectAddRequest,
	type RuntimeProjectRemoveRequest,
	type RuntimeShellSessionStartRequest,
	type RuntimeTaskChatAbortRequest,
	type RuntimeTaskChatCancelRequest,
	type RuntimeTaskChatMessagesRequest,
	type RuntimeTaskChatReloadRequest,
	type RuntimeTaskChatSendRequest,
	type RuntimeTaskSessionAttachmentRequest,
	type RuntimeTaskSessionInputRequest,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStopRequest,
	type RuntimeTaskWorkspaceInfoRequest,
	type RuntimeTerminalWsClientMessage,
	type RuntimeWorkspaceAttachmentDeleteFileRequest,
	type RuntimeWorkspaceAttachmentDeleteRequest,
	type RuntimeWorkspaceAttachmentRequest,
	type RuntimeWorkspaceChangesRequest,
	type RuntimeWorkspaceFileSearchRequest,
	type RuntimeWorkspaceStateSaveRequest,
	type RuntimeWorktreeDeleteRequest,
	type RuntimeWorktreeEnsureRequest,
	runtimeCommandRunRequestSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDirectoryListRequestSchema,
	runtimeFetchRemoteModelsRequestSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeHomeChatFullscreenTabsSaveRequestSchema,
	runtimeHomeChatThreadBindImChannelRequestSchema,
	runtimeHomeChatThreadCloseRequestSchema,
	runtimeHomeChatThreadCreateRequestSchema,
	runtimeHomeChatThreadImChannelIdRequestSchema,
	runtimeHomeChatThreadRenameRequestSchema,
	runtimeHomeChatThreadSetNextStepRequestSchema,
	runtimeHomeChatThreadSetTitleRequestSchema,
	runtimeHookIngestRequestSchema,
	runtimeImChatAddRequestSchema,
	runtimeImChatRemoveRequestSchema,
	runtimeKanbanMcpOAuthRequestSchema,
	runtimeKanbanMcpSettingsSaveRequestSchema,
	runtimeKanbanProviderModelsRequestSchema,
	runtimePiImChannelBindRequestSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatReloadRequestSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskSessionAttachmentRequestSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTerminalWsClientMessageSchema,
	runtimeWorkspaceAttachmentDeleteFileRequestSchema,
	runtimeWorkspaceAttachmentDeleteRequestSchema,
	runtimeWorkspaceAttachmentRequestSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeEnsureRequestSchema,
} from "./api-contract";

const trimmedStringSchema = z.string().transform((value) => value.trim());
const positiveIntegerFromQuerySchema = z.coerce.number().int().positive();

const requiredTrimmedStringSchema = (message: string) => trimmedStringSchema.pipe(z.string().min(1, message));

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Invalid request payload.");
	}
	return parsed.data;
}

export function parseWorkspaceChangesRequest(query: URLSearchParams): RuntimeWorkspaceChangesRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeWorkspaceChangesRequestSchema, { taskId, baseRef });
}

export function parseTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeTaskWorkspaceInfoRequestSchema, { taskId, baseRef });
}

export function parseOptionalTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest | null {
	if (!query.has("taskId")) {
		if (query.has("baseRef")) {
			throw new Error("baseRef query parameter requires taskId.");
		}
		return null;
	}
	return parseTaskWorkspaceInfoRequest(query);
}

export function parseWorkspaceFileSearchRequest(query: URLSearchParams): RuntimeWorkspaceFileSearchRequest {
	const normalizedQuery = parseWithSchema(trimmedStringSchema, query.get("q") ?? "");
	if (!normalizedQuery) {
		return { query: "" };
	}

	const rawLimit = query.get("limit");
	if (rawLimit == null || rawLimit.trim() === "") {
		return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
			query: normalizedQuery,
		});
	}
	const parsedLimit = positiveIntegerFromQuerySchema.safeParse(rawLimit);
	if (!parsedLimit.success) {
		throw new Error("Invalid file search limit parameter.");
	}
	return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
		query: normalizedQuery,
		limit: parsedLimit.data,
	});
}

export function parseGitCheckoutRequest(value: unknown): RuntimeGitCheckoutRequest {
	const parsed = parseWithSchema(runtimeGitCheckoutRequestSchema, value);
	const branch = parsed.branch.trim();
	if (!branch) {
		throw new Error("Branch cannot be empty.");
	}
	return {
		branch,
	};
}

export function parseWorktreeEnsureRequest(value: unknown): RuntimeWorktreeEnsureRequest {
	const parsed = parseWithSchema(runtimeWorktreeEnsureRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree ensure payload.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Invalid worktree ensure payload.");
	}
	return {
		taskId,
		baseRef,
	};
}

export function parseWorktreeDeleteRequest(value: unknown): RuntimeWorktreeDeleteRequest {
	const parsed = parseWithSchema(runtimeWorktreeDeleteRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree delete payload.");
	}
	return {
		taskId,
	};
}

export function parseWorkspaceStateSaveRequest(value: unknown): RuntimeWorkspaceStateSaveRequest {
	// `parseWithSchema` infers its return type from the schema, but this schema is large enough
	// (board + `ZodEffects`-on-`id` columns) that the inference degrades — widening
	// `board.columns[].id` to `unknown` — whenever the program's total type complexity grows
	// (e.g. when another contract schema is added elsewhere). zod has already validated the value
	// at runtime, so assert the declared output type to keep this immune to that fragility.
	return parseWithSchema(runtimeWorkspaceStateSaveRequestSchema, value) as RuntimeWorkspaceStateSaveRequest;
}

export function parseProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
	const parsed = parseWithSchema(runtimeProjectAddRequestSchema, value);
	const path = parsed.path?.trim() || undefined;
	const gitUrl = parsed.gitUrl?.trim() || undefined;
	if (!path && !gitUrl) {
		throw new Error("Either path or gitUrl is required.");
	}
	return {
		path,
		gitUrl,
		initializeGit: parsed.initializeGit,
	};
}

export function parseProjectRemoveRequest(value: unknown): RuntimeProjectRemoveRequest {
	const parsed = parseWithSchema(runtimeProjectRemoveRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
	};
}

export function parseRuntimeConfigSaveRequest(value: unknown): RuntimeConfigSaveRequest {
	return parseWithSchema(runtimeConfigSaveRequestSchema, value);
}

export function parseCommandRunRequest(value: unknown): RuntimeCommandRunRequest {
	const parsed = parseWithSchema(runtimeCommandRunRequestSchema, value);
	const command = parsed.command.trim();
	if (!command) {
		throw new Error("Command cannot be empty.");
	}
	return {
		command,
	};
}

export function parseTaskSessionStartRequest(value: unknown): RuntimeTaskSessionStartRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		baseRef,
	};
}

export function parseTaskSessionStopRequest(value: unknown): RuntimeTaskSessionStopRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStopRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session stop payload.");
	}
	return {
		taskId,
	};
}

export function parseTaskSessionInputRequest(value: unknown): RuntimeTaskSessionInputRequest {
	const parsed = parseWithSchema(runtimeTaskSessionInputRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseTaskChatMessagesRequest(value: unknown): RuntimeTaskChatMessagesRequest {
	const parsed = parseWithSchema(runtimeTaskChatMessagesRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatSendRequest(value: unknown): RuntimeTaskChatSendRequest {
	const parsed = parseWithSchema(runtimeTaskChatSendRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	const text = parsed.text.trim();
	const hasImages = Boolean(parsed.images && parsed.images.length > 0);
	if (!text && !hasImages) {
		throw new Error("Task chat text or images are required.");
	}
	return {
		...parsed,
		taskId,
		text,
	};
}

export function parseTaskSessionAttachmentRequest(value: unknown): RuntimeTaskSessionAttachmentRequest {
	const parsed = parseWithSchema(runtimeTaskSessionAttachmentRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task attachment taskId cannot be empty.");
	}
	if (!parsed.data) {
		throw new Error("Task attachment data is required.");
	}
	return {
		...parsed,
		taskId,
		name: parsed.name.trim(),
	};
}

export function parseWorkspaceAttachmentRequest(value: unknown): RuntimeWorkspaceAttachmentRequest {
	const parsed = parseWithSchema(runtimeWorkspaceAttachmentRequestSchema, value);
	const scopeId = parsed.scopeId.trim();
	if (!scopeId) {
		throw new Error("Workspace attachment scopeId cannot be empty.");
	}
	if (!parsed.data) {
		throw new Error("Workspace attachment data is required.");
	}
	// Safety of scopeId as a path segment is enforced by the store (resolveAttachmentScopeDir).
	return {
		scopeId,
		data: parsed.data,
		name: parsed.name.trim(),
	};
}

export function parseWorkspaceAttachmentDeleteRequest(value: unknown): RuntimeWorkspaceAttachmentDeleteRequest {
	const parsed = parseWithSchema(runtimeWorkspaceAttachmentDeleteRequestSchema, value);
	const scopeId = parsed.scopeId.trim();
	if (!scopeId) {
		throw new Error("Workspace attachment scopeId cannot be empty.");
	}
	return { scopeId };
}

export function parseWorkspaceAttachmentDeleteFileRequest(value: unknown): RuntimeWorkspaceAttachmentDeleteFileRequest {
	const parsed = parseWithSchema(runtimeWorkspaceAttachmentDeleteFileRequestSchema, value);
	const scopeId = parsed.scopeId.trim();
	if (!scopeId) {
		throw new Error("Workspace attachment scopeId cannot be empty.");
	}
	const fileName = parsed.fileName.trim();
	if (!fileName) {
		throw new Error("Workspace attachment fileName cannot be empty.");
	}
	// Safety of scopeId + fileName as path segments is enforced by the store
	// (resolveAttachmentScopeDir + deleteScopeAttachmentFile).
	return { scopeId, fileName };
}

export function parseHomeChatThreadCreateRequest(value: unknown): RuntimeHomeChatThreadCreateRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadCreateRequestSchema, value);
	const description = parsed.description?.trim();
	const name = parsed.name?.trim();
	if (!description && !name) {
		throw new Error("Home chat thread requires a description or a name.");
	}
	const id = parsed.id?.trim();
	return {
		...parsed,
		...(id ? { id } : { id: undefined }),
		...(description ? { description } : { description: undefined }),
		...(name ? { name } : { name: undefined }),
		...(parsed.agentId ? { agentId: parsed.agentId } : {}),
	};
}

export function parseHomeChatThreadRenameRequest(value: unknown): RuntimeHomeChatThreadRenameRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadRenameRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	const name = parsed.name.trim();
	if (!name) {
		throw new Error("Home chat thread name cannot be empty.");
	}
	return {
		id,
		name,
	};
}

export function parseHomeChatThreadCloseRequest(value: unknown): RuntimeHomeChatThreadCloseRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadCloseRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	return {
		id,
	};
}

export function parseHomeChatThreadSetTitleRequest(value: unknown): RuntimeHomeChatThreadSetTitleRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadSetTitleRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	const title = parsed.title.trim();
	if (!title) {
		throw new Error("Home chat thread title cannot be empty.");
	}
	return {
		id,
		title,
	};
}

export function parseHomeChatThreadSetNextStepRequest(value: unknown): RuntimeHomeChatThreadSetNextStepRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadSetNextStepRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	const suggestion = parsed.suggestion.trim();
	if (!suggestion) {
		throw new Error("Home chat thread next-step suggestion cannot be empty.");
	}
	return {
		id,
		suggestion,
	};
}

export function parseHomeChatThreadBindImChannelRequest(value: unknown): RuntimeHomeChatThreadBindImChannelRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadBindImChannelRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	const chatId = parsed.channel.chatId.trim();
	if (!chatId) {
		throw new Error("IM channel chatId cannot be empty.");
	}
	return {
		id,
		channel: { platform: parsed.channel.platform, chatId },
	};
}

export function parsePiImChannelBindRequest(value: unknown): RuntimePiImChannelBindRequest {
	const parsed = parseWithSchema(runtimePiImChannelBindRequestSchema, value);
	const chatId = parsed.channel.chatId.trim();
	if (!chatId) {
		throw new Error("IM channel chatId cannot be empty.");
	}
	return { channel: { platform: parsed.channel.platform, chatId } };
}

export function parseHomeChatThreadImChannelIdRequest(value: unknown): RuntimeHomeChatThreadImChannelIdRequest {
	const parsed = parseWithSchema(runtimeHomeChatThreadImChannelIdRequestSchema, value);
	const id = parsed.id.trim();
	if (!id) {
		throw new Error("Home chat thread id cannot be empty.");
	}
	return {
		id,
	};
}

export function parseImChatAddRequest(value: unknown): RuntimeImChatAddRequest {
	const parsed = parseWithSchema(runtimeImChatAddRequestSchema, value);
	const chatId = parsed.chatId.trim();
	if (!chatId) {
		throw new Error("IM chat id cannot be empty.");
	}
	const displayName = parsed.displayName?.trim();
	return {
		platform: parsed.platform,
		chatId,
		// Drop an empty/whitespace-only name so a re-add without a name keeps any existing label.
		...(displayName ? { displayName } : {}),
	};
}

export function parseImChatRemoveRequest(value: unknown): RuntimeImChatRemoveRequest {
	const parsed = parseWithSchema(runtimeImChatRemoveRequestSchema, value);
	const chatId = parsed.chatId.trim();
	if (!chatId) {
		throw new Error("IM chat id cannot be empty.");
	}
	return {
		platform: parsed.platform,
		chatId,
	};
}

export function parseHomeChatFullscreenTabsSaveRequest(value: unknown): RuntimeHomeChatFullscreenTabsSaveRequest {
	// The runtime re-sanitizes against the live thread list before writing, so this
	// only validates the wire shape. Cast the result for the same reason as
	// parseWorkspaceStateSaveRequest: keeps the fn immune to zod/tsc inference-budget
	// growth as more contract schemas are added.
	return parseWithSchema(
		runtimeHomeChatFullscreenTabsSaveRequestSchema,
		value,
	) as RuntimeHomeChatFullscreenTabsSaveRequest;
}

export function parseTaskChatAbortRequest(value: unknown): RuntimeTaskChatAbortRequest {
	const parsed = parseWithSchema(runtimeTaskChatAbortRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatReloadRequest(value: unknown): RuntimeTaskChatReloadRequest {
	const parsed = parseWithSchema(runtimeTaskChatReloadRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatCancelRequest(value: unknown): RuntimeTaskChatCancelRequest {
	const parsed = parseWithSchema(runtimeTaskChatCancelRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseKanbanProviderModelsRequest(value: unknown): RuntimeKanbanProviderModelsRequest {
	const parsed = parseWithSchema(runtimeKanbanProviderModelsRequestSchema, value);
	const providerId = parsed.providerId.trim();
	if (!providerId) {
		throw new Error("Provider ID cannot be empty.");
	}
	return {
		providerId,
	};
}

export function parseFetchRemoteModelsRequest(value: unknown): RuntimeFetchRemoteModelsRequest {
	return parseWithSchema(runtimeFetchRemoteModelsRequestSchema, value);
}

export function parseKanbanMcpSettingsSaveRequest(value: unknown): RuntimeKanbanMcpSettingsSaveRequest {
	const parsed = parseWithSchema(runtimeKanbanMcpSettingsSaveRequestSchema, value);
	const normalizedServers = parsed.servers.map((server) => {
		const name = server.name.trim();
		if (!name) {
			throw new Error("MCP server name cannot be empty.");
		}

		if (server.type === "stdio") {
			const command = server.command.trim();
			if (!command) {
				throw new Error(`MCP server "${name}" requires a command.`);
			}
			const args = server.args?.map((value) => value.trim()).filter((value) => value.length > 0);
			const cwd = server.cwd?.trim() || undefined;
			const env = server.env
				? Object.fromEntries(
						Object.entries(server.env)
							.map(([key, entry]) => [key.trim(), entry.trim()] as const)
							.filter(([key, entry]) => key.length > 0 && entry.length > 0),
					)
				: undefined;

			return {
				name,
				disabled: server.disabled,
				type: "stdio" as const,
				command,
				...(args && args.length > 0 ? { args } : {}),
				...(cwd ? { cwd } : {}),
				...(env && Object.keys(env).length > 0 ? { env } : {}),
			};
		}

		const url = server.url.trim();
		if (!url) {
			throw new Error(`MCP server "${name}" requires a URL.`);
		}
		const headers = server.headers
			? Object.fromEntries(
					Object.entries(server.headers)
						.map(([key, entry]) => [key.trim(), entry.trim()] as const)
						.filter(([key, entry]) => key.length > 0 && entry.length > 0),
				)
			: undefined;

		return {
			name,
			disabled: server.disabled,
			type: server.type,
			url,
			...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
		};
	});

	const seen = new Set<string>();
	for (const server of normalizedServers) {
		const dedupeKey = server.name.toLowerCase();
		if (seen.has(dedupeKey)) {
			throw new Error(`MCP server "${server.name}" is duplicated.`);
		}
		seen.add(dedupeKey);
	}

	return {
		servers: normalizedServers,
	};
}

export function parseKanbanMcpOAuthRequest(value: unknown): RuntimeKanbanMcpOAuthRequest {
	const parsed = parseWithSchema(runtimeKanbanMcpOAuthRequestSchema, value);
	const serverName = parsed.serverName.trim();
	if (!serverName) {
		throw new Error("MCP server name cannot be empty.");
	}
	return {
		serverName,
	};
}

export function parseShellSessionStartRequest(value: unknown): RuntimeShellSessionStartRequest {
	const parsed = parseWithSchema(runtimeShellSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Shell session taskId cannot be empty.");
	}
	if (parsed.workspaceTaskId !== undefined && !parsed.workspaceTaskId.trim()) {
		throw new Error("Invalid shell session workspaceTaskId.");
	}
	const workspaceTaskId = parsed.workspaceTaskId?.trim() || undefined;
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Shell session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		workspaceTaskId,
		baseRef,
	};
}

export function parseHookIngestRequest(value: unknown): RuntimeHookIngestRequest {
	const parsed = parseWithSchema(runtimeHookIngestRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const workspaceId = parsed.workspaceId.trim();
	if (!taskId) {
		throw new Error("Missing taskId");
	}
	if (!workspaceId) {
		throw new Error("Missing workspaceId");
	}
	const metadata = parsed.metadata
		? {
				activityText: parsed.metadata.activityText?.trim(),
				toolName: parsed.metadata.toolName?.trim(),
				finalMessage: parsed.metadata.finalMessage?.trim(),
				hookEventName: parsed.metadata.hookEventName?.trim(),
				notificationType: parsed.metadata.notificationType?.trim(),
				source: parsed.metadata.source?.trim(),
			}
		: undefined;
	return {
		...parsed,
		taskId,
		workspaceId,
		metadata,
	};
}

export function parseTerminalWsClientMessage(value: unknown): RuntimeTerminalWsClientMessage | null {
	const parsed = runtimeTerminalWsClientMessageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

export function parseDirectoryListRequest(value: unknown): RuntimeDirectoryListRequest {
	return parseWithSchema(runtimeDirectoryListRequestSchema, value);
}
