// Tool bridge for pi agent sessions.
// Provides built-in coding tools (read/write/list/search files, execute command)
// and integrates MCP tools as extra tools.
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool, AgentToolResult, ToolTier } from "../types";

// Async, shell-backed command runner. Replaces the previous `execSync` calls so
// `execute_command`/`search_files` no longer block the entire runtime event
// loop for the lifetime of the child (up to the 60s/30s tool timeouts). `exec`
// (not `execFile`) is required because callers rely on shell semantics — the
// search tool pipes `grep ... | head`, and `execute_command` runs arbitrary
// user shell commands.
const execAsync = promisify(exec);

export type PiToolTier = ToolTier;

export interface PiToolApprovalRequest {
	toolName: string;
	args: Record<string, unknown>;
	tier: PiToolTier;
}

export interface PiToolApprovalResult {
	approved: boolean;
	reason?: string;
}

/** A subagent spawn request issued by the `task` tool (parentTaskId is bound by the runtime). */
export interface SpawnSubagentRequest {
	subagentId: string;
	label: string;
	prompt: string;
	modelOverride?: string;
	signal?: AbortSignal;
}

export interface SpawnSubagentResult {
	finalText: string;
	isError: boolean;
}

export type SpawnSubagentFn = (request: SpawnSubagentRequest) => Promise<SpawnSubagentResult>;

export interface BuildPiToolSetOptions {
	cwd: string;
	extraTools?: AgentTool<any>[];
	onToolApproval?: (request: PiToolApprovalRequest) => Promise<PiToolApprovalResult>;
	/**
	 * When set, adds the `task` tool that lets the agent delegate an independent sub-task to a
	 * fresh subagent (a child Agent run). Omitted for child agents themselves, so subagents
	 * cannot recursively fan out (depth-1, matching omp's own multiagent constraint).
	 */
	spawnSubagent?: SpawnSubagentFn;
}

/**
 * Build the full tool set for a pi agent session.
 * Includes 5 built-in coding tools, an optional `task` (subagent) tool, plus any extra
 * tools (e.g. MCP).
 */
export function buildPiToolSet(options: BuildPiToolSetOptions): AgentTool<any>[] {
	const { cwd } = options;
	// Use dynamic require for zod to avoid hard dependency at module level
	const z = require("zod");

	const tools: AgentTool<any>[] = [
		createReadFileTool(cwd, z),
		createWriteFileTool(cwd, z),
		createListFilesTool(cwd, z),
		createSearchFilesTool(cwd, z),
		createExecuteCommandTool(cwd, z),
	];

	if (options.spawnSubagent) {
		tools.push(createTaskTool(z, options.spawnSubagent));
	}

	if (options.extraTools && options.extraTools.length > 0) {
		tools.push(...options.extraTools);
	}

	return tools;
}

/** Mint a filesystem/id-safe subagent id (`[A-Za-z0-9]`, so the composite session id is greppable). */
function mintSubagentId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

function createTaskTool(z: any, spawnSubagent: SpawnSubagentFn): AgentTool<any> {
	return {
		name: "task",
		label: "Delegate to Subagent",
		description:
			"Delegate an independent, well-scoped sub-task to a fresh subagent with its own context " +
			"window. Use for parallel or independent workstreams and focused deep-dives. The subagent " +
			"returns only its final text; it does not share your conversation and cannot spawn further " +
			"subagents.",
		parameters: z.object({
			description: z.string().describe("Short 3-5 word label for the subagent's task"),
			prompt: z.string().describe("The complete, self-contained instruction for the subagent"),
			model: z.string().optional().describe("Optional model id override; defaults to the parent's model"),
		}),
		approval: "exec",
		async execute(
			_toolCallId: string,
			params: { description: string; prompt: string; model?: string },
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			const result = await spawnSubagent({
				subagentId: mintSubagentId(),
				label: params.description,
				prompt: params.prompt,
				modelOverride: params.model,
				signal,
			});
			return { content: [{ type: "text", text: result.finalText || "(subagent returned no text)" }], isError: result.isError };
		},
	};
}

/**
 * Create a beforeToolCall hook that bridges pi tool approvals
 * to the Kanban approval flow.
 */
export function createPiToolApprovalHook(
	onApproval?: (request: PiToolApprovalRequest) => Promise<PiToolApprovalResult>,
) {
	if (!onApproval) return undefined;

	return async (context: {
		toolCall: { name: string };
		args: Record<string, unknown>;
	}): Promise<{ block?: boolean; reason?: string } | undefined> => {
		const tier = resolveToolTier(context.toolCall.name);
		const result = await onApproval({
			toolName: context.toolCall.name,
			args: context.args,
			tier,
		});
		if (!result.approved) {
			return { block: true, reason: result.reason ?? "Tool call rejected by user" };
		}
		return undefined;
	};
}

function resolveToolTier(toolName: string): PiToolTier {
	const readTools = new Set(["read_file", "list_files", "search_files"]);
	const writeTools = new Set(["write_file"]);
	if (readTools.has(toolName)) return "read";
	if (writeTools.has(toolName)) return "write";
	return "exec";
}

function createReadFileTool(cwd: string, z: any): AgentTool<any> {
	return {
		name: "read_file",
		label: "Read File",
		description: "Read the contents of a file at the given path relative to the workspace.",
		parameters: z.object({
			path: z.string().describe("File path relative to workspace root"),
			startLine: z.number().optional().describe("Start line (1-based, inclusive)"),
			endLine: z.number().optional().describe("End line (1-based, inclusive)"),
		}),
		approval: "read",
		async execute(
			_toolCallId: string,
			params: { path: string; startLine?: number; endLine?: number },
		): Promise<AgentToolResult> {
			try {
				const fullPath = resolve(cwd, params.path);
				const content = readFileSync(fullPath, "utf8");
				if (params.startLine || params.endLine) {
					const lines = content.split("\n");
					const start = (params.startLine ?? 1) - 1;
					const end = params.endLine ?? lines.length;
					const sliced = lines.slice(start, end).join("\n");
					return { content: [{ type: "text", text: sliced }] };
				}
				return { content: [{ type: "text", text: content }] };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error reading file: ${msg}` }], isError: true };
			}
		},
	};
}

function createWriteFileTool(cwd: string, z: any): AgentTool<any> {
	return {
		name: "write_file",
		label: "Write File",
		description: "Write content to a file. Creates parent directories if needed.",
		parameters: z.object({
			path: z.string().describe("File path relative to workspace root"),
			content: z.string().describe("File content to write"),
		}),
		approval: "write",
		async execute(
			_toolCallId: string,
			params: { path: string; content: string },
		): Promise<AgentToolResult> {
			try {
				const fullPath = resolve(cwd, params.path);
				const { mkdirSync } = require("node:fs");
				const { dirname } = require("node:path");
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, params.content, "utf8");
				return { content: [{ type: "text", text: `Successfully wrote to ${params.path}` }] };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error writing file: ${msg}` }], isError: true };
			}
		},
	};
}

function createListFilesTool(cwd: string, z: any): AgentTool<any> {
	return {
		name: "list_files",
		label: "List Files",
		description: "List files and directories at the given path. Supports recursive listing.",
		parameters: z.object({
			path: z.string().optional().describe("Directory path relative to workspace root (default: .)"),
			recursive: z.boolean().optional().describe("List recursively (default: false)"),
			maxDepth: z.number().optional().describe("Maximum depth for recursive listing"),
		}),
		approval: "read",
		async execute(
			_toolCallId: string,
			params: { path?: string; recursive?: boolean; maxDepth?: number },
		): Promise<AgentToolResult> {
			try {
				const targetPath = resolve(cwd, params.path ?? ".");
				const entries = listDirectoryEntries(targetPath, {
					recursive: params.recursive ?? false,
					maxDepth: params.maxDepth ?? 3,
					currentDepth: 0,
					basePath: cwd,
				});
				const text = entries.length > 0 ? entries.join("\n") : "(empty directory)";
				return { content: [{ type: "text", text }] };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error listing files: ${msg}` }], isError: true };
			}
		},
	};
}

function listDirectoryEntries(
	dirPath: string,
	opts: { recursive: boolean; maxDepth: number; currentDepth: number; basePath: string },
): string[] {
	const entries: string[] = [];
	try {
		const items = readdirSync(dirPath, { withFileTypes: true });
		for (const item of items) {
			if (item.name.startsWith(".") && item.name !== ".env") continue;
			if (item.name === "node_modules" || item.name === "dist" || item.name === "build") continue;

			const relPath = relative(opts.basePath, join(dirPath, item.name));
			if (item.isDirectory()) {
				entries.push(`${relPath}/`);
				if (opts.recursive && opts.currentDepth < opts.maxDepth) {
					entries.push(
						...listDirectoryEntries(join(dirPath, item.name), {
							...opts,
							currentDepth: opts.currentDepth + 1,
						}),
					);
				}
			} else {
				entries.push(relPath);
			}
		}
	} catch {
		// Permission denied or not a directory
	}
	return entries;
}

function createSearchFilesTool(cwd: string, z: any): AgentTool<any> {
	return {
		name: "search_files",
		label: "Search Files",
		description: "Search file contents using a regex pattern. Returns matching lines with file paths.",
		parameters: z.object({
			pattern: z.string().describe("Regex pattern to search for"),
			path: z.string().optional().describe("Directory to search in (default: workspace root)"),
			fileGlob: z.string().optional().describe("File extension filter (e.g. '.ts')"),
			maxResults: z.number().optional().describe("Maximum number of results (default: 50)"),
		}),
		approval: "read",
		async execute(
			_toolCallId: string,
			params: { pattern: string; path?: string; fileGlob?: string; maxResults?: number },
		): Promise<AgentToolResult> {
			try {
				const searchPath = resolve(cwd, params.path ?? ".");
				const maxResults = params.maxResults ?? 50;
				// Use grep command for efficient searching
				const globArg = params.fileGlob ? `--include='*${params.fileGlob}'` : "";
				const cmd = `grep -rn ${globArg} -E '${params.pattern.replace(/'/g, "'\\''")}' '${searchPath}' | head -${maxResults}`;
				const { stdout } = await execAsync(cmd, {
					cwd,
					encoding: "utf8",
					maxBuffer: 10 * 1024 * 1024,
					timeout: 30000,
				});
				const text = stdout.trim() || "No matches found.";
				return { content: [{ type: "text", text }] };
			} catch (error) {
				// grep returns exit code 1 when no matches found
				if (error && typeof error === "object" && "stdout" in error) {
					const stdout = (error as { stdout: string }).stdout?.trim();
					if (stdout) {
						return { content: [{ type: "text", text: stdout }] };
					}
				}
				return { content: [{ type: "text", text: "No matches found." }] };
			}
		},
	};
}

function createExecuteCommandTool(cwd: string, z: any): AgentTool<any> {
	return {
		name: "execute_command",
		label: "Execute Command",
		description: "Execute a shell command in the workspace directory. Use with caution.",
		parameters: z.object({
			command: z.string().describe("Shell command to execute"),
			timeout: z.number().optional().describe("Timeout in milliseconds (default: 60000)"),
		}),
		approval: "exec",
		async execute(
			_toolCallId: string,
			params: { command: string; timeout?: number },
		): Promise<AgentToolResult> {
			try {
				const timeout = params.timeout ?? 60000;
				const { stdout } = await execAsync(params.command, {
					cwd,
					encoding: "utf8",
					maxBuffer: 10 * 1024 * 1024,
					timeout,
				});
				return { content: [{ type: "text", text: stdout || "(no output)" }] };
			} catch (error) {
				if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
					// promisify(exec) attaches stdout/stderr to the rejection error and
					// exposes the exit status as `code` (execSync used `status`).
					const execError = error as { stdout: string; stderr: string; code?: number };
					const parts: string[] = [];
					if (execError.stdout) parts.push(`stdout:\n${execError.stdout}`);
					if (execError.stderr) parts.push(`stderr:\n${execError.stderr}`);
					if (typeof execError.code === "number") parts.push(`exit code: ${execError.code}`);
					return {
						content: [{ type: "text", text: parts.join("\n") || "Command failed with no output" }],
						isError: true,
					};
				}
				const msg = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Command failed: ${msg}` }], isError: true };
			}
		},
	};
}
