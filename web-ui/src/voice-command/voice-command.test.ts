import { describe, expect, it } from "vitest";

import {
	buildAgentInstruction,
	describeResolvedCommand,
	parseVoiceCommand,
	planVoiceCommand,
	type ResolvedVoiceCommand,
	resolveVoiceCommand,
	type VoiceCommandBoard,
} from "./voice-command";

function board(): VoiceCommandBoard {
	return {
		columns: [
			{
				id: "backlog",
				title: "待办",
				cards: [
					{ id: "t1", title: "修复登录 bug", prompt: "fix the login bug" },
					{ id: "t2", title: "重构导航栏", prompt: "refactor navbar" },
				],
			},
			{ id: "in_progress", title: "进行中", cards: [{ id: "t3", title: "支付接口", prompt: "payment api" }] },
			{ id: "review", title: "评审", cards: [] },
			{ id: "trash", title: "完成", cards: [] },
		],
	};
}

describe("parseVoiceCommand", () => {
	it("parses Chinese create with a title after a colon", () => {
		expect(parseVoiceCommand("新建一个任务:修复登录 bug")).toEqual({ kind: "create", title: "修复登录 bug" });
	});

	it("parses create without a colon and trailing 任务", () => {
		expect(parseVoiceCommand("创建修复登录bug任务")).toEqual({ kind: "create", title: "修复登录bug" });
	});

	it("parses English create", () => {
		expect(parseVoiceCommand("create a task: fix login bug")).toEqual({ kind: "create", title: "fix login bug" });
	});

	it("parses start of the top backlog task", () => {
		expect(parseVoiceCommand("启动顶部待办任务")).toEqual({ kind: "start", target: { kind: "topBacklog" } });
	});

	it("parses start by title", () => {
		expect(parseVoiceCommand("启动任务 修复登录 bug")).toEqual({
			kind: "start",
			target: { kind: "title", query: "修复登录 bug" },
		});
	});

	it("parses move to a column (Chinese)", () => {
		expect(parseVoiceCommand("把登录 bug 移到 done")).toEqual({
			kind: "move",
			target: { kind: "title", query: "登录 bug" },
			column: { raw: "done", columnId: "trash" },
		});
	});

	it("parses move (English)", () => {
		expect(parseVoiceCommand("move payment api to review")).toEqual({
			kind: "move",
			target: { kind: "title", query: "payment api" },
			column: { raw: "review", columnId: "review" },
		});
	});

	it("strips the 列 suffix and demonstrative task nouns", () => {
		expect(parseVoiceCommand("把这条任务移到完成列")).toEqual({
			kind: "move",
			target: { kind: "title", query: "" },
			column: { raw: "完成", columnId: "trash" },
		});
	});

	it("parses delete (trailing form)", () => {
		expect(parseVoiceCommand("把重构导航栏删掉")).toEqual({
			kind: "delete",
			target: { kind: "title", query: "重构导航栏" },
		});
	});

	it("parses delete (leading verb form)", () => {
		expect(parseVoiceCommand("删除任务 支付接口")).toEqual({
			kind: "delete",
			target: { kind: "title", query: "支付接口" },
		});
	});

	it("falls back to chat for unrecognized text", () => {
		expect(parseVoiceCommand("帮我看看这个错误是什么原因")).toEqual({
			kind: "chat",
			text: "帮我看看这个错误是什么原因",
		});
	});

	it("treats empty input as chat", () => {
		expect(parseVoiceCommand("   ")).toEqual({ kind: "chat", text: "" });
	});
});

describe("resolveVoiceCommand", () => {
	it("resolves the top backlog card", () => {
		const resolved = resolveVoiceCommand({ kind: "start", target: { kind: "topBacklog" } }, board());
		expect(resolved).toEqual({ kind: "start", card: { id: "t1", name: "修复登录 bug" } });
	});

	it("rejects start of top backlog when backlog is empty", () => {
		const empty: VoiceCommandBoard = { columns: [{ id: "backlog", title: "待办", cards: [] }] };
		const resolved = resolveVoiceCommand({ kind: "start", target: { kind: "topBacklog" } }, empty);
		expect(resolved).toMatchObject({ reason: "empty-backlog" });
	});

	it("resolves a card by title substring", () => {
		const resolved = resolveVoiceCommand(
			{ kind: "move", target: { kind: "title", query: "登录" }, column: { raw: "done", columnId: "trash" } },
			board(),
		);
		expect(resolved).toEqual({
			kind: "move",
			card: { id: "t1", name: "修复登录 bug" },
			columnId: "trash",
			columnTitle: "完成",
		});
	});

	it("rejects when the task is not found", () => {
		const resolved = resolveVoiceCommand(
			{ kind: "delete", target: { kind: "title", query: "不存在的任务" } },
			board(),
		);
		expect(resolved).toMatchObject({ reason: "task-not-found" });
	});

	it("rejects ambiguous title matches", () => {
		const ambiguous: VoiceCommandBoard = {
			columns: [
				{
					id: "backlog",
					title: "待办",
					cards: [
						{ id: "a", title: "登录页面", prompt: "" },
						{ id: "b", title: "登录接口", prompt: "" },
					],
				},
			],
		};
		const resolved = resolveVoiceCommand({ kind: "delete", target: { kind: "title", query: "登录" } }, ambiguous);
		expect(resolved).toMatchObject({ reason: "task-ambiguous" });
	});

	it("rejects a demonstrative-only target with needs-task-name", () => {
		const resolved = resolveVoiceCommand(
			{ kind: "move", target: { kind: "title", query: "" }, column: { raw: "完成", columnId: "trash" } },
			board(),
		);
		expect(resolved).toMatchObject({ reason: "needs-task-name" });
	});

	it("rejects an unknown column", () => {
		const resolved = resolveVoiceCommand(
			{ kind: "move", target: { kind: "title", query: "登录" }, column: { raw: "火星", columnId: null } },
			board(),
		);
		expect(resolved).toMatchObject({ reason: "unknown-column" });
	});

	it("rejects an empty create title", () => {
		const resolved = resolveVoiceCommand({ kind: "create", title: "   " }, board());
		expect(resolved).toMatchObject({ reason: "empty-title" });
	});

	it("prefers an exact title match over substrings", () => {
		const b: VoiceCommandBoard = {
			columns: [
				{
					id: "backlog",
					title: "待办",
					cards: [
						{ id: "a", title: "登录", prompt: "" },
						{ id: "b", title: "登录页面优化", prompt: "" },
					],
				},
			],
		};
		const resolved = resolveVoiceCommand({ kind: "delete", target: { kind: "title", query: "登录" } }, b);
		expect(resolved).toEqual({
			kind: "delete",
			card: { id: "a", name: "登录" },
			columnId: "trash",
			columnTitle: "trash",
		});
	});
});

describe("describeResolvedCommand", () => {
	it("describes a move", () => {
		const resolved: ResolvedVoiceCommand = {
			kind: "move",
			card: { id: "t1", name: "登录 bug" },
			columnId: "trash",
			columnTitle: "完成",
		};
		expect(describeResolvedCommand(resolved)).toEqual({ title: "移动任务", detail: "「登录 bug」 →「完成」" });
	});

	it("describes a create", () => {
		expect(describeResolvedCommand({ kind: "create", title: "修复登录 bug" })).toEqual({
			title: "新建任务",
			detail: "标题:「修复登录 bug」",
		});
	});
});

describe("buildAgentInstruction", () => {
	it("includes the task id for a move", () => {
		const instruction = buildAgentInstruction({
			kind: "move",
			card: { id: "t1", name: "登录 bug" },
			columnId: "trash",
			columnTitle: "完成",
		});
		expect(instruction).toBe("请把任务「登录 bug」(任务 id: t1)移动到「完成」列");
	});

	it("includes the task id for start and delete", () => {
		expect(buildAgentInstruction({ kind: "start", card: { id: "t1", name: "X" } })).toContain("任务 id: t1");
		expect(
			buildAgentInstruction({
				kind: "delete",
				card: { id: "t2", name: "Y" },
				columnId: "trash",
				columnTitle: "完成",
			}),
		).toContain("任务 id: t2");
	});

	it("builds a create instruction without an id", () => {
		expect(buildAgentInstruction({ kind: "create", title: "修复登录 bug" })).toBe("请新建一个任务,标题:修复登录 bug");
	});
});

describe("planVoiceCommand", () => {
	it("returns chat for unrecognized text", () => {
		expect(planVoiceCommand("解释一下这段代码", board())).toEqual({ kind: "chat", text: "解释一下这段代码" });
	});

	it("returns confirm with summary for a recognized command", () => {
		const outcome = planVoiceCommand("新建一个任务:修复登录 bug", board());
		expect(outcome.kind).toBe("confirm");
		if (outcome.kind === "confirm") {
			expect(outcome.resolved).toEqual({ kind: "create", title: "修复登录 bug" });
			expect(outcome.summary.title).toBe("新建任务");
		}
	});

	it("returns reject (carrying the text) when a command can't resolve", () => {
		const outcome = planVoiceCommand("把不存在的任务移到完成", board());
		expect(outcome.kind).toBe("reject");
		if (outcome.kind === "reject") {
			expect(outcome.rejection.reason).toBe("task-not-found");
			expect(outcome.text).toBe("把不存在的任务移到完成");
		}
	});

	it("confirms moving the top backlog example end to end", () => {
		const outcome = planVoiceCommand("启动顶部待办任务", board());
		expect(outcome.kind).toBe("confirm");
		if (outcome.kind === "confirm") {
			expect(buildAgentInstruction(outcome.resolved)).toBe("请启动任务「修复登录 bug」(任务 id: t1)");
		}
	});
});
