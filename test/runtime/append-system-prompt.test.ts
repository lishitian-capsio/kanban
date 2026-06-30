import { describe, expect, it } from "vitest";

import {
	renderAppendSystemPrompt,
	resolveAppendSystemPromptCommandPrefix,
	resolveHomeAgentAppendSystemPrompt,
} from "../../src/prompts/append-system-prompt";
import type { VaultTypeDefinition } from "../../src/vault/vault-types";

const SAMPLE_VAULT_TYPES: VaultTypeDefinition[] = [
	{
		type: "requirement",
		label: "Requirement",
		description: "A customer-facing problem statement.",
		slugField: "title",
		body: "Authoring prompt for requirements.",
	},
	{
		type: "customer",
		label: "Customer",
		description: "A customer or account the work serves.",
		slugField: "title",
		body: "Authoring prompt for customers.",
	},
];

describe("resolveAppendSystemPromptCommandPrefix", () => {
	it("returns npx prefix for npx transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/Users/example/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("npx -y kanban");
	});

	it("returns bun x prefix for bun x transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("bun x kanban");
	});

	it("falls back to the current runnable invocation for local entrypoints", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js'");
	});

	it("falls back to the current runnable invocation when realpath resolution fails", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/tmp/missing-kanban-cli.js"],
			resolveRealPath: () => {
				throw new Error("missing");
			},
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/tmp/missing-kanban-cli.js'");
	});
});

describe("renderAppendSystemPrompt", () => {
	it("always renders the Kanban sidebar guidance and task command reference", () => {
		const rendered = renderAppendSystemPrompt("kanban");
		expect(rendered).toContain("Kanban sidebar agent");
		expect(rendered).toContain("kanban task create");
		expect(rendered).toContain("kanban task done");
		expect(rendered).toContain("kanban task delete");
		expect(rendered).toContain("--column backlog|in_progress|review|done");
		expect(rendered).toContain("Provide exactly one of");
		expect(rendered).toContain("task delete --column done");
		expect(rendered).toContain("kanban task link");
		// The requirement subsystem and its bespoke CLI are retired in favor of vault documents.
		expect(rendered).not.toContain("kanban requirement");
		expect(rendered).not.toContain("requirement history");
		expect(rendered).not.toContain("requirement revert");
		expect(rendered).not.toContain("requirement review");
		expect(rendered).not.toContain("requirement reconcile");
		expect(rendered).not.toContain("requirement confirm-link");
		expect(rendered).not.toContain("requirement reject-link");
		expect(rendered).toContain("If a task command fails because the runtime is unavailable");
		expect(rendered).toContain("If the user asks for GitHub work");
		expect(rendered).toContain("gh issue view");
		expect(rendered).toContain("If the user references Linear");
		expect(rendered).toContain("Current home agent: `unknown`");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
	});

	it("injects NO vault content at all when vault management is off (default), keeping task CLI reference", () => {
		const rendered = renderAppendSystemPrompt("kanban", { vaultTypes: SAMPLE_VAULT_TYPES });
		// Task CLI reference is always present.
		expect(rendered).toContain("kanban task create");
		expect(rendered).toContain("## task start");
		// No vault intro / type index / vault CLI reference / directive.
		expect(rendered).not.toContain("# Knowledge vault documents");
		expect(rendered).not.toContain("Tasks and vault documents are independent things");
		expect(rendered).not.toContain("No document types are defined in this workspace yet");
		expect(rendered).not.toContain("This workspace defines the following document types");
		expect(rendered).not.toContain("## vault type list");
		expect(rendered).not.toContain("kanban vault doc create");
		expect(rendered).not.toContain("Proactive vault management is ENABLED");
	});

	it("omits the self-titling directive by default and includes it when selfTitleDirective is set", () => {
		const withoutDirective = renderAppendSystemPrompt("kanban");
		expect(withoutDirective).not.toContain("# Name this chat thread");
		expect(withoutDirective).not.toContain("home-thread set-title");

		const withDirective = renderAppendSystemPrompt("kanban", { selfTitleDirective: true });
		expect(withDirective).toContain("# Name this chat thread");
		expect(withDirective).toContain('kanban home-thread set-title "<title>"');
		expect(withDirective).toContain("manually renamed");
	});

	it("omits the next-step directive by default and includes it when suggestNextStepDirective is set", () => {
		const withoutDirective = renderAppendSystemPrompt("kanban");
		expect(withoutDirective).not.toContain("# Suggest a next step");
		expect(withoutDirective).not.toContain("home-thread suggest-next");

		const withDirective = renderAppendSystemPrompt("kanban", { suggestNextStepDirective: true });
		expect(withDirective).toContain("# Suggest a next step");
		expect(withDirective).toContain('kanban home-thread suggest-next "<text>"');
		expect(withDirective).toContain("clickable button");
	});

	it("renders only the active-agent Linear MCP guidance when an agent is provided", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentId: "codex",
		});

		expect(rendered).toContain("Current home agent: `codex`");
		expect(rendered).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("injects the FULL vault guidance when vault management is enabled", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentVaultManagementEnabled: true,
			vaultTypes: SAMPLE_VAULT_TYPES,
		});
		// Intro present.
		expect(rendered).toContain("# Knowledge vault documents");
		expect(rendered).toContain("Tasks and vault documents are independent things");
		// Vault CLI reference present.
		expect(rendered).toContain("## vault type list");
		expect(rendered).toContain("## vault doc delete");
		expect(rendered).toContain("kanban vault doc create");
		// Type index present: each type appears as a light index entry.
		expect(rendered).toContain("This workspace defines the following document types");
		expect(rendered).toContain("- `requirement` — A customer-facing problem statement.");
		expect(rendered).toContain("kanban vault doc create --type requirement");
		expect(rendered).toContain("- `customer` — A customer or account the work serves.");
		// The agent is told to load the full authoring prompt on demand before writing.
		expect(rendered).toContain("kanban vault type show --type <type>");
		expect(rendered).toContain("FIRST run");
		// The authoring prompt bodies themselves are NOT inlined.
		expect(rendered).not.toContain("Authoring prompt for requirements.");
		// Proactive-management directive present.
		expect(rendered).toContain("Proactive vault management is ENABLED");
		expect(rendered).toContain("you are authorized to proactively");
	});

	it("falls back to the empty-state index when enabled with no types supplied", () => {
		const rendered = renderAppendSystemPrompt("kanban", { agentVaultManagementEnabled: true });
		expect(rendered).toContain("No document types are defined in this workspace yet");
		expect(rendered).not.toContain("--type requirement");
		expect(rendered).not.toContain("proposed | clarified | parked | invalid");
	});

	it("sorts vault types by id regardless of input order when enabled", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentVaultManagementEnabled: true,
			vaultTypes: [SAMPLE_VAULT_TYPES[1], SAMPLE_VAULT_TYPES[0]],
		});

		expect(rendered.indexOf("`customer`")).toBeLessThan(rendered.indexOf("`requirement`"));
	});

	it("omits the dash summary for a type without a description when enabled", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentVaultManagementEnabled: true,
			vaultTypes: [{ type: "note", label: "Note", slugField: "title", body: "" }],
		});

		expect(rendered).toContain("- `note`. Create with `kanban vault doc create --type note`.");
	});
});

describe("resolveHomeAgentAppendSystemPrompt", () => {
	it("returns null for non-home task sessions", async () => {
		expect(await resolveHomeAgentAppendSystemPrompt("task-1")).toBeNull();
	});

	it("returns the appended prompt for current home sidebar sessions", async () => {
		const prompt = await resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Kanban sidebar agent");
		expect(prompt).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task list");
		expect(prompt).toContain("Current home agent: `codex`");
		expect(prompt).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(prompt).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
	});

	it("returns active-agent guidance for droid home sidebar sessions", async () => {
		const prompt = await resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:droid", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `droid`");
		expect(prompt).toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("resolves the agent id from a threaded home session id", async () => {
		const prompt = await resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex:thread-abc", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `codex`");
		expect(prompt).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		// Non-default threads get both the self-titling and the next-step directives.
		expect(prompt).toContain("# Name this chat thread");
		expect(prompt).toContain("# Suggest a next step");
	});

	it("omits the self-title and next-step directives for the default (3-segment) home session", async () => {
		const prompt = await resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).not.toContain("# Name this chat thread");
		expect(prompt).not.toContain("# Suggest a next step");
	});

	it("returns active-agent guidance for kiro home sidebar sessions", async () => {
		const prompt = await resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:kiro", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `kiro`");
		expect(prompt).toContain("kiro-cli mcp add --name linear --url https://mcp.linear.app/mcp --scope global");
		expect(prompt).not.toContain("--scope user");
	});
});
