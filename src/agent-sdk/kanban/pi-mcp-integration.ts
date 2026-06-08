// MCP tool integration for pi agent sessions.
// Connects to MCP servers, discovers tools, and wraps them as omp AgentTools.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "../types";

export interface PiMcpServerConfig {
	name: string;
	type: "stdio" | "sse" | "streamableHttp";
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
}

export interface PiMcpToolBundle {
	tools: AgentTool<any>[];
	warnings: string[];
	dispose: () => Promise<void>;
}

export interface PiMcpRuntimeService {
	createToolBundle(): Promise<PiMcpToolBundle>;
	dispose(): Promise<void>;
}

/**
 * Create an MCP runtime service for pi agent sessions.
 * Loads MCP server configurations and manages connections.
 */
export function createPiMcpRuntimeService(): PiMcpRuntimeService {
	let activeConnections: Array<{ close: () => Promise<void> }> = [];

	async function createToolBundle(): Promise<PiMcpToolBundle> {
		const configs = loadDefaultMcpSettings();
		const tools: AgentTool<any>[] = [];
		const warnings: string[] = [];
		activeConnections = [];

		for (const config of configs) {
			if (config.disabled) continue;
			try {
				const serverTools = await connectAndDiscoverTools(config);
				tools.push(...serverTools.tools);
				if (serverTools.connection) {
					activeConnections.push(serverTools.connection);
				}
				warnings.push(...serverTools.warnings);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				warnings.push(`MCP server '${config.name}' failed: ${msg}`);
			}
		}

		return {
			tools,
			warnings,
			dispose: async () => {
				await Promise.all(activeConnections.map((conn) => conn.close().catch(() => {})));
				activeConnections = [];
			},
		};
	}

	return {
		createToolBundle,
		dispose: async () => {
			await Promise.all(activeConnections.map((conn) => conn.close().catch(() => {})));
			activeConnections = [];
		},
	};
}

interface McpServerConnection {
	tools: AgentTool<any>[];
	connection: { close: () => Promise<void> } | null;
	warnings: string[];
}

/**
 * Connect to an MCP server and discover its tools.
 * Uses dynamic import of @modelcontextprotocol/sdk to avoid hard dependency.
 */
async function connectAndDiscoverTools(config: PiMcpServerConfig): Promise<McpServerConnection> {
	const warnings: string[] = [];

	try {
		// Dynamic import to keep @modelcontextprotocol/sdk optional
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

		if (config.type === "stdio" && config.command) {
			const transport = new StdioClientTransport({
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env ? { ...process.env, ...config.env } : undefined,
			});

			const client = new Client({ name: "kanban-pi-mcp", version: "1.0.0" });
			await client.connect(transport);

			const toolsResult = await client.listTools();
			const tools: AgentTool<any>[] = (toolsResult.tools ?? []).map((mcpTool: any) =>
				wrapMcpToolAsAgentTool(client, config.name, mcpTool),
			);

			return {
				tools,
				connection: { close: async () => client.close() },
				warnings,
			};
		}

		// SSE and streamableHttp not yet implemented for pi
		warnings.push(`MCP server '${config.name}': transport type '${config.type}' not yet supported in pi adapter`);
		return { tools: [], connection: null, warnings };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		warnings.push(`MCP server '${config.name}' connection failed: ${msg}`);
		return { tools: [], connection: null, warnings };
	}
}

/**
 * Wrap an MCP tool as an omp AgentTool.
 */
function wrapMcpToolAsAgentTool(
	client: any,
	serverName: string,
	mcpTool: { name: string; description?: string; inputSchema?: any },
): AgentTool<any> {
	const z = require("zod");
	const parameterSchema = mcpTool.inputSchema ? jsonSchemaToZod(mcpTool.inputSchema, z) : z.object({});

	return {
		name: `mcp_${serverName}_${mcpTool.name}`,
		label: `${serverName}: ${mcpTool.name}`,
		description: mcpTool.description ?? `MCP tool from ${serverName}`,
		parameters: parameterSchema,
		approval: "exec",
		async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult> {
			try {
				const result = await client.callTool({
					name: mcpTool.name,
					arguments: params,
				});
				const content = result.content ?? [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "text" && typeof part.text === "string") {
						textParts.push(part.text);
					} else if (part.type === "image") {
						textParts.push("[image content]");
					} else {
						textParts.push(JSON.stringify(part));
					}
				}
				return {
					content: [{ type: "text", text: textParts.join("\n") || "(no output)" }],
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `MCP tool error: ${msg}` }],
					isError: true,
				};
			}
		},
	};
}

/**
 * Best-effort conversion from JSON Schema to Zod schema.
 * Handles common types; falls back to z.any() for complex cases.
 */
function jsonSchemaToZod(schema: any, z: any): any {
	if (!schema || typeof schema !== "object") return z.object({});

	const properties = schema.properties;
	if (!properties || typeof properties !== "object") return z.object({});

	const shape: Record<string, any> = {};
	const required = new Set(schema.required ?? []);

	for (const [key, value] of Object.entries(properties)) {
		const prop = value as any;
		let fieldSchema: any;

		switch (prop.type) {
			case "string":
				fieldSchema = z.string();
				break;
			case "number":
			case "integer":
				fieldSchema = z.number();
				break;
			case "boolean":
				fieldSchema = z.boolean();
				break;
			case "array":
				fieldSchema = z.array(jsonSchemaToZod(prop.items ?? {}, z));
				break;
			case "object":
				fieldSchema = jsonSchemaToZod(prop, z);
				break;
			default:
				fieldSchema = z.any();
		}

		if (prop.description) {
			fieldSchema = fieldSchema.describe(prop.description);
		}

		if (!required.has(key)) {
			fieldSchema = fieldSchema.optional();
		}

		shape[key] = fieldSchema;
	}

	return z.object(shape);
}

/**
 * Load MCP settings from the default location.
 * Compatible with the kanban MCP settings format.
 */
export function loadDefaultMcpSettings(): PiMcpServerConfig[] {
	const settingsPath = join(homedir(), ".kanban", "pi", "mcp_settings.json");
	try {
		const content = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(content);
		if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
			return Object.entries(parsed.mcpServers).map(([name, config]: [string, any]) => ({
				name,
				type: config.type ?? "stdio",
				command: config.command,
				args: config.args,
				cwd: config.cwd,
				env: config.env,
				url: config.url,
				headers: config.headers,
				disabled: config.disabled === true,
			}));
		}
	} catch {
		// No settings file or invalid JSON
	}
	return [];
}
