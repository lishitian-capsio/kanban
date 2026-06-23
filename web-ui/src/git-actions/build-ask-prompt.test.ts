import { describe, expect, it } from "vitest";

import { buildAskKanbanAgentPrompt, buildAskSelfPrompt } from "./build-ask-prompt";

describe("buildAskSelfPrompt", () => {
	it("quotes the question and asks the agent to decide and continue", () => {
		const prompt = buildAskSelfPrompt({ question: "Use A or B?", taskTitle: "Wire auth" });
		expect(prompt).toContain("> Use A or B?");
		expect(prompt).toContain("make your own best judgment");
	});

	it("blockquotes every line of a multi-line question", () => {
		const prompt = buildAskSelfPrompt({ question: "line one\nline two", taskTitle: "T" });
		expect(prompt).toContain("> line one\n> line two");
	});

	it("falls back to a generic nudge with the title when there is no question", () => {
		const prompt = buildAskSelfPrompt({ question: null, taskTitle: "Wire auth" });
		expect(prompt).toContain('"Wire auth"');
		expect(prompt).not.toContain(">");
	});
});

describe("buildAskKanbanAgentPrompt", () => {
	const base = {
		question: "Use A or B?",
		taskId: "abc123",
		taskTitle: "Wire auth",
		taskPrompt: "Implement login",
		workspacePath: "/repo/.kanban/worktrees/abc123/x",
	};

	it("includes task id, title, prompt, worktree and the quoted question", () => {
		const prompt = buildAskKanbanAgentPrompt(base);
		expect(prompt).toContain("Wire auth (abc123)");
		expect(prompt).toContain("Worktree: /repo/.kanban/worktrees/abc123/x");
		expect(prompt).toContain("> Implement login");
		expect(prompt).toContain("> Use A or B?");
	});

	it("embeds the loop guardrail / escalate-to-human intent", () => {
		const prompt = buildAskKanbanAgentPrompt(base);
		expect(prompt).toContain("Do not loop indefinitely");
		expect(prompt).toContain("escalate to a human");
	});

	it("omits the worktree line when not provided", () => {
		const prompt = buildAskKanbanAgentPrompt({ ...base, workspacePath: null });
		expect(prompt).not.toContain("Worktree:");
	});

	it("notes the absence of a question instead of quoting an empty one", () => {
		const prompt = buildAskKanbanAgentPrompt({ ...base, question: "" });
		expect(prompt).toContain("stopped for review without a specific question");
	});
});
