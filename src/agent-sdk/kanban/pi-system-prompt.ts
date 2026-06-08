// System prompt builder for pi agent sessions.
// Assembles a task-appropriate system prompt from base instructions,
// workspace context, project rules, and user-provided custom prompts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KANBAN_BASE_SYSTEM_PROMPT = `You are a senior software engineer working inside a Kanban task board.
You have full access to the project workspace and can read, write, and search files, run commands, and use MCP tools.

Guidelines:
- Always read relevant files before making changes.
- Prefer small, focused edits over large rewrites.
- Explain your reasoning briefly when making non-obvious decisions.
- If a task is ambiguous, ask clarifying questions before proceeding.
- When you finish a task, summarize what you changed and any follow-up items.`;

export interface BuildPiSystemPromptInput {
	cwd: string;
	customPrompt?: string | null;
	rules?: string | null;
	mode?: "act" | "plan";
	startInPlanMode?: boolean;
}

/**
 * Build the full system prompt for a pi agent session.
 */
export function buildPiSystemPrompt(input: BuildPiSystemPromptInput): string {
	const parts: string[] = [KANBAN_BASE_SYSTEM_PROMPT];

	const workspaceContext = buildWorkspaceContext(input.cwd);
	if (workspaceContext) {
		parts.push(workspaceContext);
	}

	const rules = input.rules ?? loadPiRules(input.cwd);
	if (rules) {
		parts.push(`## Project Rules\n${rules}`);
	}

	if (input.startInPlanMode || input.mode === "plan") {
		parts.push(PLAN_MODE_INSTRUCTIONS);
	}

	const custom = input.customPrompt?.trim();
	if (custom) {
		parts.push(`## Additional Instructions\n${custom}`);
	}

	return parts.join("\n\n");
}

const PLAN_MODE_INSTRUCTIONS = `## Plan Mode
You are currently in plan mode. Inspect the codebase and produce a clear implementation plan only.
Do not modify files, do not use write tools, and do not implement anything yet.
After you present the plan, ask for approval before making changes.`;

function buildWorkspaceContext(cwd: string): string | null {
	try {
		const packageJsonPath = join(cwd, "package.json");
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
			const name = pkg.name ?? "unnamed";
			const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 20).join(", ");
			return `## Workspace\nProject: ${name}\nPath: ${cwd}${deps ? `\nKey dependencies: ${deps}` : ""}`;
		} catch {
			// No package.json
		}
		return `## Workspace\nPath: ${cwd}`;
	} catch {
		return null;
	}
}

/**
 * Load project rules from conventional locations.
 */
export function loadPiRules(cwd: string): string | null {
	const candidates = [
		join(cwd, ".kanban", "rules.md"),
		join(cwd, ".kanban", "rules"),
	];
	for (const candidate of candidates) {
		try {
			const content = readFileSync(candidate, "utf8").trim();
			if (content.length > 0) {
				return content;
			}
		} catch {
			// File doesn't exist, try next
		}
	}
	return null;
}
