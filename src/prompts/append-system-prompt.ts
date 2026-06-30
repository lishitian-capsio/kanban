import { realpathSync } from "node:fs";

import packageJson from "../../package.json" with { type: "json" };

import type { RuntimeAgentId } from "../core/api-contract";
import { DEFAULT_HOME_THREAD_ID, isHomeAgentSessionId, parseHomeAgentSessionId } from "../core/home-agent-session";
import { resolveKanbanCommandParts } from "../core/kanban-command";
import { buildShellCommandLine } from "../core/shell";
import { resolveRepoPathForWorkspaceId } from "../state/workspace-state";
import { detectAutoUpdateInstallation, UpdatePackageManager } from "../update/update";
import { VaultSettingsStore } from "../vault/vault-settings-store";
import { VaultTypeRegistry } from "../vault/vault-type-registry";
import type { VaultTypeDefinition } from "../vault/vault-types";

const DEFAULT_COMMAND_PREFIX = "kanban";
const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

export interface ResolveAppendSystemPromptCommandPrefixOptions {
	currentVersion?: string;
	argv?: string[];
	execArgv?: string[];
	execPath?: string;
	cwd?: string;
	resolveRealPath?: (path: string) => string;
}

export interface RenderAppendSystemPromptOptions {
	agentId?: RuntimeAgentId | null;
	/**
	 * The workspace's vault document types, as discovered by the type registry
	 * (the light "index" tier: name + description, no authoring prompt body). Used
	 * to render the progressive-disclosure vault-types section. Defaults to empty,
	 * which renders the type-agnostic "no types defined" guidance.
	 */
	vaultTypes?: readonly VaultTypeDefinition[];
	/**
	 * When true, append the thread self-titling directive: the agent summarizes a concise
	 * title for its own thread and sets it via `home-thread set-title`. Enabled for created
	 * (non-default) home threads only — the synthetic default thread keeps its fixed label.
	 */
	selfTitleDirective?: boolean;
	/**
	 * When true, append the next-step suggestion directive: at the end of a turn the agent may
	 * propose ONE concise, ready-to-send next-step prompt via `home-thread suggest-next`, which
	 * the sidebar renders as a clickable chip. Enabled for created (non-default) home threads
	 * only — same gating as {@link selfTitleDirective}.
	 */
	suggestNextStepDirective?: boolean;
	/**
	 * The workspace's vault-takeover switch (see
	 * `RuntimeVaultSettings.agentVaultManagementEnabled`), a plain on/off boolean. When
	 * `true`, the full vault guidance is injected — the vault intro, the per-workspace
	 * document-type index, the vault CLI command reference, and the proactive-management
	 * directive. When `false` (the default), no vault content is injected at all.
	 */
	agentVaultManagementEnabled?: boolean;
}

const APPEND_PROMPT_AGENT_IDS: readonly RuntimeAgentId[] = [
	"claude",
	"codex",
	"droid",
	"kiro",
	"qoder",
	"gemini",
	"opencode",
];

function isRuntimeAgentId(value: string): value is RuntimeAgentId {
	return APPEND_PROMPT_AGENT_IDS.includes(value as RuntimeAgentId);
}

function resolveHomeAgentId(taskId: string): RuntimeAgentId | null {
	const parts = parseHomeAgentSessionId(taskId);
	if (!parts || !isRuntimeAgentId(parts.agentId)) {
		return null;
	}
	return parts.agentId;
}

function renderLinearSetupGuidanceForAgent(agentId: RuntimeAgentId | null): string {
	switch (agentId) {
		case "claude":
			return "- If Linear MCP is not available in the current agent (Claude Code), suggest running: `claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp`";
		case "codex":
			return "- If Linear MCP is not available in the current agent (OpenAI Codex), suggest running: `codex mcp add linear --url https://mcp.linear.app/mcp`";
		case "gemini":
			return "- If Linear MCP is not available in the current agent (Gemini CLI), suggest running: `gemini mcp add linear https://mcp.linear.app/mcp --transport http --scope user`";
		case "opencode":
			return "- If Linear MCP is not available in the current agent (OpenCode), suggest running `opencode mcp add`, then use name `linear` and URL `https://mcp.linear.app/mcp`.";
		case "droid":
			return "- If Linear MCP is not available in the current agent (Droid), suggest running: `droid mcp add linear https://mcp.linear.app/mcp --type http`";
		case "kiro":
			return "- If Linear MCP is not available in the current agent (Kiro CLI), suggest running: `kiro-cli mcp add --name linear --url https://mcp.linear.app/mcp --scope global`";
		case "qoder":
			return "- If Linear MCP is not available in the current agent (Qoder CLI), suggest running: `qodercli mcp add --transport http --scope user linear https://mcp.linear.app/mcp`";
		default:
			return "- If Linear MCP is not available, provide setup instructions for the active agent only, then continue once OAuth is complete.";
	}
}

/**
 * Render the "knowledge vault documents" intro paragraph — the type-agnostic
 * framing of what the vault is, that reading/editing docs is allowed work, and
 * that tasks and documents are independent. Injected when vault management is enabled.
 * Pure and side-effect-free so the rendering logic is unit-testable.
 */
function renderVaultIntroSection(): string {
	return `# Knowledge vault documents

Kanban tracks structured knowledge as documents in a git-backed vault: each document is a markdown file with YAML frontmatter under \`.kanban/files/docs/<type>/\`, managed through the \`vault doc\` CLI commands listed below. Reading and editing vault documents is allowed work for you; it is not implementation work, so do not redirect it to task creation. Document history lives in git, so there is no separate version-history or revert command.

Tasks and vault documents are independent things. There is no ordering, hierarchy, or parent-child relationship between them: a document does not own or contain tasks, and a task does not belong under a document. A document may optionally reference tasks through its frontmatter, but this is an optional lateral reference, not a hierarchy.`;
}

/**
 * Render the "document type index" as skill-style progressive disclosure: list each
 * discovered type by name + one-line description + its create command (the light
 * index), and instruct the agent to load a type's full authoring prompt on demand
 * via `vault type show` before writing a document of that type.
 *
 * This is type-agnostic — there are no per-type branches. When no types are defined,
 * it degrades to generic vault-document guidance that still points at the discovery
 * commands. Injected when vault management is enabled. Pure and side-effect-free.
 */
function renderVaultTypeIndexSection(types: readonly VaultTypeDefinition[], kanbanCommand: string): string {
	if (types.length === 0) {
		return `No document types are defined in this workspace yet. You can still create a document of any type with \`${kanbanCommand} vault doc create --type <type>\`. To discover the types a workspace offers, run \`${kanbanCommand} vault type list\`; before authoring a document of a given type, run \`${kanbanCommand} vault type show --type <type>\` to read that type's authoring guidance and follow it.`;
	}

	const typeLines = [...types]
		.sort((left, right) => left.type.localeCompare(right.type))
		.map((definition) => {
			// Strip a trailing sentence period so descriptions that end in "." don't render "..".
			const description = definition.description?.trim().replace(/\.$/, "");
			const summary = description ? ` — ${description}` : "";
			return `- \`${definition.type}\`${summary}. Create with \`${kanbanCommand} vault doc create --type ${definition.type}\`.`;
		})
		.join("\n");

	return `This workspace defines the following document types (a light index — name and one-line purpose only):
${typeLines}

Each type is self-governing: it carries its own authoring prompt describing which frontmatter fields to set, what the body should contain, and how its status flows. Before you create or update a document of a given type, FIRST run \`${kanbanCommand} vault type show --type <type>\` to read that type's full authoring prompt, then write the document exactly as that prompt instructs. The list above intentionally omits those rules — load them on demand for the type you are about to write.`;
}

/**
 * Render the vault CLI command reference (the `## vault type list` … `## vault doc
 * delete` sections). Extracted from the main template so it can be gated by the
 * vault-management switch — injected when enabled, omitted entirely when off.
 * Pure and side-effect-free.
 */
function renderVaultCliReference(kanbanCommand: string): string {
	return `## vault type list

Purpose: list the workspace's document types as a light index (name + description + metadata, without each type's authoring prompt). Use this to discover which types exist.

Command:
\`${kanbanCommand} vault type list [--project-path <path>]\`

Parameters:
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

## vault type show

Purpose: show a type's full definition, including the self-governing authoring prompt (body). Run this before creating or updating a document of that type, and follow the prompt it returns.

Command:
\`${kanbanCommand} vault type show --type <type> [--project-path <path>]\`

Parameters:
- \`--type <type>\` required type id (e.g. \`requirement\`).
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

## vault doc list

Purpose: list knowledge-vault documents for a workspace, optionally filtered by type.

Command:
\`${kanbanCommand} vault doc list [--type <type>] [--project-path <path>]\`

Parameters:
- \`--type <type>\` optional document type filter, e.g. \`requirement\`.
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

## vault doc show

Purpose: show a single vault document (frontmatter + markdown body).

Command:
\`${kanbanCommand} vault doc show --id <id> [--project-path <path>]\`

Parameters:
- \`--id <id>\` required document ID.
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

## vault doc create

Purpose: create a vault document of a given type. Run \`vault type show --type <type>\` first to learn the type's required frontmatter and body; the type's default frontmatter is applied before your \`--set\` overrides.

Command:
\`${kanbanCommand} vault doc create --type <type> --title "<text>" [--body "<markdown>"] [--body-file <path>] [--set key=value ...] [--project-path <path>]\`

Parameters:
- \`--type <type>\` required document type, e.g. \`requirement\`.
- \`--title "<text>"\` required document title.
- \`--body "<markdown>"\` optional markdown body (the document's main content, per the type's authoring prompt).
- \`--body-file <path>\` optional path to read the markdown body from a file.
- \`--set key=value\` optional frontmatter field, repeatable (e.g. \`--set status=proposed --set priority=high\`).
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

## vault doc update

Purpose: update a vault document. Omitted fields are left unchanged.

Command:
\`${kanbanCommand} vault doc update --id <id> [--title "<text>"] [--body "<markdown>"] [--body-file <path>] [--set key=value ...] [--project-path <path>]\`

Parameters:
- \`--id <id>\` required document ID.
- \`--title "<text>"\` optional replacement title (re-slugs the filename).
- \`--body "<markdown>"\` optional replacement markdown body.
- \`--body-file <path>\` optional path to read the replacement body from a file.
- \`--set key=value\` optional frontmatter field to set, repeatable (e.g. \`--set status=clarified\`).
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.

Notes:
- Provide at least one of \`--title\`, \`--body\`, \`--body-file\`, or \`--set\` in addition to \`--id\`.

## vault doc delete

Purpose: permanently delete a vault document.

Command:
\`${kanbanCommand} vault doc delete --id <id> [--project-path <path>]\`

Parameters:
- \`--id <id>\` required document ID to delete.
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.`;
}

/**
 * Render the vault "documents" prompt section: the intro plus the document-type
 * index. Returns an empty string when vault management is disabled. Pure and
 * side-effect-free.
 */
function renderVaultDocumentsSection(
	enabled: boolean,
	types: readonly VaultTypeDefinition[],
	kanbanCommand: string,
): string {
	if (!enabled) {
		return "";
	}
	return [renderVaultIntroSection(), renderVaultTypeIndexSection(types, kanbanCommand)].join("\n\n");
}

/**
 * Render the optional "proactive vault management" directive injected only when the
 * workspace's vault-takeover switch is ON. By default Kanban treats the vault like
 * the board — the agent acts on it only under an explicit instruction. This block
 * flips that posture: it authorizes the agent to maintain the vault on its own
 * initiative, while deliberately NOT hardcoding a procedure — what to write and when
 * is governed by each type's self-describing authoring prompt (`vault type show`).
 * Injected only when vault management is enabled. Pure/side-effect-free.
 */
function renderVaultManagedDirective(kanbanCommand: string): string {
	return `# Proactive vault management is ENABLED

For this workspace, vault management has been handed to you: you are authorized to proactively create and maintain knowledge-vault documents, not only when explicitly told to. At appropriate moments — for example when a conversation surfaces a durable fact, decision, requirement, or other knowledge that matches a document type — you may create or update the relevant vault document yourself, without waiting for an explicit request.

This authorization is scoped to the vault only. It does NOT make you a coding agent: never edit workspace code or files, and continue to redirect implementation work to Kanban tasks.

Do not invent a fixed routine. Let each document type govern what you write: before creating or updating a document of a given type, run \`${kanbanCommand} vault type show --type <type>\` and follow that type's authoring prompt. Prefer updating an existing document over creating a duplicate (use \`${kanbanCommand} vault doc list\` and \`${kanbanCommand} vault doc show\` to check first). Keep changes proportionate and relevant; when in doubt about a large or destructive change, ask the user first.`;
}

/**
 * Render the thread self-titling directive: the conversational agent itself (no separate
 * summarizer) names its own thread early and keeps it current, while respecting a manual
 * rename. Injected only for created (non-default) home threads. Pure/side-effect-free.
 */
function renderSelfTitleDirective(kanbanCommand: string): string {
	return `# Name this chat thread

This conversation is a named chat thread in the Kanban sidebar, and you are responsible for keeping its title meaningful — there is no separate process that does this.

- Early in the conversation (after the user's first message and your first substantive reply), summarize what this thread is about as a concise 3-6 word title and set it by running \`${kanbanCommand} home-thread set-title "<title>"\`. You do not need to pass the thread or session id — the command resolves them from the session it is run in.
- If the conversation's topic meaningfully shifts later, run the same command again with an updated title. Do not re-title for minor follow-ups — only when the thread is genuinely about something new.
- Keep titles short, specific, and human-readable (e.g. "Fix flaky auth tests", "Plan Q3 billing migration"). No quotes inside the title, no trailing punctuation.
- If the user has manually renamed the thread, the command will report that the title is pinned and leave it unchanged. Respect that: do not keep trying to re-title a thread the user has named.`;
}

/**
 * Render the next-step suggestion directive: at the end of a turn the agent proposes at most
 * one concise, self-contained next-step prompt via `home-thread suggest-next`, which the sidebar
 * surfaces as a clickable chip. Because clicking sends the text verbatim as the user's next
 * message, it must read as a ready-to-send user message. Injected only for created (non-default)
 * home threads. Pure/side-effect-free.
 */
function renderSuggestNextStepDirective(kanbanCommand: string): string {
	return `# Suggest a next step

At the end of your turn, if there is an obvious next action the user is likely to want, you may propose exactly ONE next step by running \`${kanbanCommand} home-thread suggest-next "<text>"\`. The sidebar shows it as a single clickable button above the composer; clicking it sends your text verbatim as the user's next message, so the user can proceed in one click (or ignore it).

- Write the suggestion as a ready-to-send user message, in the user's voice and addressed to you (e.g. "Start the top backlog task", "Break this into tasks and link them", "Show me the tasks in review"). Do NOT phrase it as a question to the user or as a description of what you will do.
- Keep it short, concrete, and self-contained — it must make sense on its own, without relying on this message's context.
- Propose at most one, and only when the next step is genuinely obvious. When there is no clear next step, do not run the command at all. Do not repeat a suggestion the user already declined.
- You do not need to pass the thread or session id — the command resolves them from the session it is run in.`;
}

export function resolveAppendSystemPromptCommandPrefix(
	options: ResolveAppendSystemPromptCommandPrefixOptions = {},
): string {
	const argv = options.argv ?? process.argv;
	const fallbackCommandParts = resolveKanbanCommandParts({
		execPath: options.execPath ?? process.execPath,
		argv,
		execArgv: options.execArgv ?? process.execArgv,
	});
	const fallbackCommandPrefix = buildShellCommandLine(
		fallbackCommandParts[0] ?? DEFAULT_COMMAND_PREFIX,
		fallbackCommandParts.slice(1),
	);
	const entrypointArg = argv[1];
	if (!entrypointArg) {
		return fallbackCommandPrefix;
	}

	const resolveRealPath = options.resolveRealPath ?? realpathSync;
	let entrypointPath: string;
	try {
		entrypointPath = resolveRealPath(entrypointArg);
	} catch {
		return fallbackCommandPrefix;
	}

	const installation = detectAutoUpdateInstallation({
		currentVersion: options.currentVersion ?? KANBAN_VERSION,
		packageName: "kanban",
		entrypointPath,
		cwd: options.cwd ?? process.cwd(),
	});

	if (installation.updateTiming !== "shutdown") {
		return fallbackCommandPrefix;
	}

	if (installation.packageManager === UpdatePackageManager.NPX) {
		return "npx -y kanban";
	}
	if (installation.packageManager === UpdatePackageManager.PNPM) {
		return "pnpm dlx kanban";
	}
	if (installation.packageManager === UpdatePackageManager.YARN) {
		return "yarn dlx kanban";
	}
	if (installation.packageManager === UpdatePackageManager.BUN) {
		return "bun x kanban";
	}

	return fallbackCommandPrefix;
}

export function renderAppendSystemPrompt(commandPrefix: string, options: RenderAppendSystemPromptOptions = {}): string {
	const kanbanCommand = commandPrefix.trim() || DEFAULT_COMMAND_PREFIX;
	const selectedAgentId = options.agentId ?? null;
	const vaultManagementEnabled = options.agentVaultManagementEnabled ?? false;
	const vaultDocumentsSection = renderVaultDocumentsSection(
		vaultManagementEnabled,
		options.vaultTypes ?? [],
		kanbanCommand,
	);
	const vaultManagedDirective = vaultManagementEnabled ? renderVaultManagedDirective(kanbanCommand) : "";
	const vaultIntroAndManaged = [vaultDocumentsSection, vaultManagedDirective].filter(Boolean).join("\n\n");
	const vaultIntroBlock = vaultIntroAndManaged ? `\n${vaultIntroAndManaged}\n` : "";
	const vaultCliReference = vaultManagementEnabled ? renderVaultCliReference(kanbanCommand) : "";
	const vaultCliReferenceBlock = vaultCliReference ? `${vaultCliReference}\n\n` : "";
	const selfTitleBlock = options.selfTitleDirective ? `\n${renderSelfTitleDirective(kanbanCommand)}\n` : "";
	const suggestNextStepBlock = options.suggestNextStepDirective
		? `\n${renderSuggestNextStepDirective(kanbanCommand)}\n`
		: "";
	return `# Kanban Sidebar

You are the Kanban sidebar agent for this workspace. Help the user interact with their Kanban board directly from this side panel. When the user asks to add tasks, create tasks, break work down, link tasks, or start tasks, prefer using the Kanban CLI yourself instead of describing manual steps.

Kanban is a CLI tool for orchestrating multiple coding agents working on tasks in parallel on a kanban board. It manages git worktrees automatically so that each task can run a dedicated CLI agent in its own worktree.

You are a Kanban board management helper: your job is to create, organize, link, start, and manage tasks, and to manage the workspace's knowledge-vault documents, using the Kanban CLI.

# CRITICAL: You are NOT a coding agent

NEVER edit, create, delete, or modify any files in the workspace. NEVER write code, fix bugs, refactor, or do any implementation work yourself. You do not have the role of a coding assistant. Your only job is to manage the Kanban board using the Kanban CLI commands listed below.

If the user asks you to write code, fix a bug, implement a feature, refactor, or do any hands-on development work, do NOT attempt it. Instead, help them by creating tasks on the Kanban board so a dedicated coding agent can do that work in its own worktree. Always redirect implementation requests to task creation.

- If the user asks to add tasks to kb, ask kb, kanban, or says add tasks without other context, they likely want to add tasks in Kanban. This includes phrases like "create tasks", "make 3 tasks", "add a task", "break down into tasks", "split into tasks", "decompose into tasks", and "turn into tasks".
- Kanban also supports linking tasks. Linking is useful both for parallelization and for dependencies: when work is easy to decompose into multiple pieces that can be done in parallel, link multiple backlog tasks to the same dependency so they all become ready to start once that dependency finishes; when one piece of work depends on another, use links to represent that follow-on dependency. If both linked tasks are in backlog, Kanban preserves the order you pass to the command: \`--task-id\` waits on \`--linked-task-id\`, and on the board the arrow points into \`--linked-task-id\`. Once only one linked task remains in backlog, Kanban reorients the saved dependency so the backlog task is the waiting dependent task and the other task is the prerequisite. The board arrow points into the prerequisite task so the user can see what must finish first. A link requires at least one backlog task, and when the linked review task is moved to done, that backlog task becomes ready to start.
- How linking works: when a task in the review column is moved to done, any linked backlog tasks automatically start. This is how you chain work so tasks kick off autonomously without manual intervention.
- Tasks can also enable automatic review actions: auto-commit or auto-open-pr once completed, which then moves the task to done and kicks off any linked tasks. Combining auto-review with linking is how you can set up fully autonomous pipelines when the user wants it. For example, enabling auto-commit on each task in a chain: task A finishes, auto-commits and is moved to done, task B auto-starts from backlog, auto-commits and is moved to done, task C auto-starts, and so on.
- If your current working directory is inside \`.kanban/worktrees/\`, you are inside a Kanban task worktree. In that case, create or manage tasks against the main workspace path, not the task worktree path. Pass the main workspace with \`--project-path\`.
- If a task command fails because the runtime is unavailable, tell the user to start Kanban in that workspace first with \`${kanbanCommand}\`, then retry the task command.
${selfTitleBlock}${suggestNextStepBlock}${vaultIntroBlock}
# Command Prefix

Use this prefix for every Kanban command in this session:
\`${kanbanCommand}\`

# Tool Invocation Notes

- NEVER use file-editing tools. You are not a coding agent. If you catch yourself about to edit a file, stop and suggest creating a Kanban task instead.
- When using the \`run_commands\` tool, always pass \`commands\` as an array, even when running only one command.

# GitHub and Linear Guidance

- If the user asks for GitHub work (issues, PRs, repos, comments, labels, milestones) or includes a \`github.com\` URL, prefer the \`gh\` CLI first.
- Prefer native GitHub commands over manual browser walkthroughs when possible, for example: \`gh issue view\`, \`gh pr view\`, \`gh repo view\`, \`gh pr checks\`, \`gh pr diff\`.
- If \`gh\` is missing, guide installation based on platform:
  - macOS: \`brew install gh\`
  - Windows: \`winget install --id GitHub.cli\`
  - Linux: use the distro package or official instructions at \`https://cli.github.com/\`

- If the user references Linear (Linear links, Linear issue IDs, or Linear workflows), prefer Linear MCP tools when available.
- Current home agent: \`${selectedAgentId ?? "unknown"}\`
${renderLinearSetupGuidanceForAgent(selectedAgentId)}
- After setup, run the agent MCP auth flow (often \`/mcp\`) and complete OAuth before using Linear tools.
- Linear MCP docs: \`https://linear.app/docs/mcp\`

# CLI Reference

All commands return JSON.

## task list

Purpose: list Kanban tasks for a workspace, including auto-review settings and dependency links.

Command:
\`${kanbanCommand} task list [--project-path <path>] [--column backlog|in_progress|review|done]\`

Parameters:
- \`--project-path <path>\` optional workspace path. If omitted, uses the current working directory workspace.
- \`--column <value>\` optional filter. Allowed values: \`backlog\`, \`in_progress\`, \`review\`, \`done\` (\`trash\` is also accepted).

## task create

Purpose: create a new task in \`backlog\`, with optional plan mode and auto-review behavior.

Command:
\`${kanbanCommand} task create [--title "<text>"] --prompt "<text>" [--project-path <path>] [--base-ref <branch>] [--start-in-plan-mode <true|false>] [--auto-review-enabled <true|false>] [--auto-review-mode commit|pr]\`

Parameters:
- \`--title "<text>"\` optional task title. If omitted, Kanban derives one from the prompt.
- \`--prompt "<text>"\` required task prompt text.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.
- \`--base-ref <branch>\` optional base branch/worktree ref. Defaults to current branch, then default branch, then first known branch.
- \`--start-in-plan-mode <true|false>\` optional. Default false. Set true only when explicitly requested.
- \`--auto-review-enabled <true|false>\` optional. Default false. Enables automatic action once task reaches review.
- \`--auto-review-mode commit|pr\` optional auto-review action. Default \`commit\`.

## task update

Purpose: update an existing task, including prompt, base ref, plan mode, and auto-review behavior.

Command:
\`${kanbanCommand} task update --task-id <task_id> [--title "<text>"] [--prompt "<text>"] [--project-path <path>] [--base-ref <branch>] [--start-in-plan-mode <true|false>] [--auto-review-enabled <true|false>] [--auto-review-mode commit|pr]\`

Parameters:
- \`--task-id <task_id>\` required task ID.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.
- \`--title "<text>"\` optional replacement title.
- \`--prompt "<text>"\` optional replacement prompt text.
- \`--base-ref <branch>\` optional replacement base ref.
- \`--start-in-plan-mode <true|false>\` optional replacement of plan-mode behavior.
- \`--auto-review-enabled <true|false>\` optional replacement of auto-review toggle. Set false to cancel pending automatic review actions.
- \`--auto-review-mode commit|pr\` optional replacement auto-review action.

Notes:
- Provide at least one field to change in addition to \`--task-id\`.

## task done

Purpose: move a task or an entire column to \`done\`, stop active sessions if needed, clean up task worktrees, and auto-start any linked backlog tasks that become ready. \`task trash\` is also accepted as an alias.

Command:
\`${kanbanCommand} task done (--task-id <task_id> | --column backlog|in_progress|review|done) [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` optional single-task target.
- \`--column <value>\` optional bulk target. Allowed values: \`backlog\`, \`in_progress\`, \`review\`, \`done\` (\`trash\` is also accepted).
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.

Notes:
- Provide exactly one of \`--task-id\` or \`--column\`.
- \`task done --column done\` is a no-op for tasks already in done.

## task delete

Purpose: permanently delete a task or every task in a column, removing cards, dependency links, and task worktrees.

Command:
\`${kanbanCommand} task delete (--task-id <task_id> | --column backlog|in_progress|review|done) [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` optional single-task target.
- \`--column <value>\` optional bulk target. Allowed values: \`backlog\`, \`in_progress\`, \`review\`, \`done\` (\`trash\` is also accepted).
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.

Notes:
- Provide exactly one of \`--task-id\` or \`--column\`.
- \`task delete --column done\` is the way to clear the done column.

## task link

Purpose: link two tasks so one task waits on another. At least one linked task must be in backlog.

Command:
\`${kanbanCommand} task link --task-id <task_id> --linked-task-id <task_id> [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` required one of the two task IDs to link.
- \`--linked-task-id <task_id>\` required the other task ID to link.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.

Notes:
- If both linked tasks are in backlog, Kanban preserves the order you pass: \`--task-id\` waits on \`--linked-task-id\`.
- On the board, the dependency arrow points into the task that must finish first.
- Once only one linked task remains in backlog, Kanban reorients the saved dependency so the backlog task is the waiting dependent task and the other task is the prerequisite.
- When the prerequisite task finishes review and is moved to done, the waiting backlog task auto-starts.

## task unlink

Purpose: remove an existing task link (dependency) by dependency ID.

Command:
\`${kanbanCommand} task unlink --dependency-id <dependency_id> [--project-path <path>]\`

Parameters:
- \`--dependency-id <dependency_id>\` required dependency ID. Use \`task list\` to inspect existing links.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.

## task start

Purpose: start a task by ensuring its worktree, launching its agent session, and moving it to \`in_progress\`.

Command:
\`${kanbanCommand} task start --task-id <task_id> [--project-path <path>]\`

Parameters:
- \`--task-id <task_id>\` required task ID.
- \`--project-path <path>\` optional workspace path. If not already registered in Kanban, it is auto-added for git repos.

${vaultCliReferenceBlock}# Workflow Notes

- Prefer \`task list\` first when task IDs or dependency IDs are needed.
- To create multiple linked tasks, create tasks first, then call \`task link\` for each dependency edge.
`;
}

/**
 * Load the workspace's vault document types (light index tier) for the home session
 * encoded in `taskId`. Resolves the repo path from the parsed workspace id, then asks
 * the type registry to scan `docs/_types/`. Degrades to an empty list — never throws —
 * when the workspace is unknown or the scan fails, so prompt rendering still succeeds.
 */
async function loadVaultTypesForHomeSession(taskId: string): Promise<readonly VaultTypeDefinition[]> {
	const parts = parseHomeAgentSessionId(taskId);
	if (!parts) {
		return [];
	}
	try {
		const repoPath = await resolveRepoPathForWorkspaceId(parts.workspaceId);
		if (!repoPath) {
			return [];
		}
		return await new VaultTypeRegistry(repoPath).list();
	} catch {
		return [];
	}
}

/**
 * Load the workspace's vault-takeover switch for the home session encoded in
 * `taskId`. Mirrors {@link loadVaultTypesForHomeSession}: resolves the repo path
 * from the parsed workspace id and degrades to `false` — never throws — when the
 * workspace is unknown or the read fails, so prompt rendering always succeeds.
 */
async function loadVaultManagementEnabledForHomeSession(taskId: string): Promise<boolean> {
	const parts = parseHomeAgentSessionId(taskId);
	if (!parts) {
		return false;
	}
	try {
		const repoPath = await resolveRepoPathForWorkspaceId(parts.workspaceId);
		if (!repoPath) {
			return false;
		}
		return (await new VaultSettingsStore(repoPath).get()).agentVaultManagementEnabled;
	} catch {
		return false;
	}
}

export async function resolveHomeAgentAppendSystemPrompt(
	taskId: string,
	options: ResolveAppendSystemPromptCommandPrefixOptions = {},
): Promise<string | null> {
	if (!isHomeAgentSessionId(taskId)) {
		return null;
	}
	const [vaultTypes, agentVaultManagementEnabled] = await Promise.all([
		loadVaultTypesForHomeSession(taskId),
		loadVaultManagementEnabledForHomeSession(taskId),
	]);
	// Self-titling is per-thread: the synthetic default thread keeps its fixed "Default"
	// label (it is not a registry entry), so only created (non-default) threads get the
	// directive to name themselves.
	const threadId = parseHomeAgentSessionId(taskId)?.threadId ?? DEFAULT_HOME_THREAD_ID;
	const isNonDefaultThread = threadId !== DEFAULT_HOME_THREAD_ID;
	return renderAppendSystemPrompt(resolveAppendSystemPromptCommandPrefix(options), {
		agentId: resolveHomeAgentId(taskId),
		selfTitleDirective: isNonDefaultThread,
		suggestNextStepDirective: isNonDefaultThread,
		vaultTypes,
		agentVaultManagementEnabled,
	});
}
