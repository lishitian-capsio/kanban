import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
} from "../../../src/core/api-contract";
import {
	findThreadBoundToImChannel,
	resolveTaskRouteFromBoard,
	resolveThreadImChannelFromThreads,
} from "../../../src/im/im-task-route-resolver";

function card(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: "Task",
		prompt: "do a thing",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards },
		],
		dependencies: [],
	};
}

describe("resolveTaskRouteFromBoard", () => {
	it("returns the originThreadId + title for a task spawned from a thread", () => {
		const b = board([card({ id: "t1", title: "Fix login", originThreadId: "thread-9" })]);
		expect(resolveTaskRouteFromBoard(b, "t1")).toEqual({ originThreadId: "thread-9", title: "Fix login" });
	});

	it("returns null for a task with no originThreadId (created directly on the board)", () => {
		const b = board([card({ id: "t1", title: "Manual task" })]);
		expect(resolveTaskRouteFromBoard(b, "t1")).toBeNull();
	});

	it("returns null for an unknown task", () => {
		const b = board([card({ id: "t1", originThreadId: "thread-9" })]);
		expect(resolveTaskRouteFromBoard(b, "missing")).toBeNull();
	});

	it("carries the resolved card title through", () => {
		const b = board([card({ id: "t1", title: "Ship it", originThreadId: "thread-9" })]);
		expect(resolveTaskRouteFromBoard(b, "t1")).toEqual({ originThreadId: "thread-9", title: "Ship it" });
	});
});

describe("resolveThreadImChannelFromThreads", () => {
	const threads = (overrides: Partial<RuntimeHomeChatThreadsData["threads"][number]>): RuntimeHomeChatThreadsData => ({
		threads: [
			{
				id: "thread-9",
				agentId: "claude",
				name: "Login work",
				titleSource: "manual",
				createdAt: 1,
				updatedAt: 1,
				...overrides,
			},
		],
	});

	it("returns the bound channel", () => {
		const data = threads({ imChannel: { platform: "lark", chatId: "oc_x" } });
		expect(resolveThreadImChannelFromThreads(data, "thread-9")).toEqual({ platform: "lark", chatId: "oc_x" });
	});

	it("returns null when the thread is unbound", () => {
		expect(resolveThreadImChannelFromThreads(threads({}), "thread-9")).toBeNull();
	});

	it("returns null for an unknown thread", () => {
		const data = threads({ imChannel: { platform: "lark", chatId: "oc_x" } });
		expect(resolveThreadImChannelFromThreads(data, "nope")).toBeNull();
	});
});

describe("findThreadBoundToImChannel", () => {
	function thread(overrides: Partial<RuntimeHomeChatThread> & { id: string }): RuntimeHomeChatThread {
		return {
			agentId: "pi",
			name: "Thread",
			titleSource: "manual",
			createdAt: 1,
			updatedAt: 1,
			...overrides,
		};
	}
	function data(threads: RuntimeHomeChatThread[]): RuntimeHomeChatThreadsData {
		return { threads };
	}

	it("returns the bound thread id + agent for a matching (platform, chatId)", () => {
		const d = data([
			thread({ id: "t-a", agentId: "pi" }),
			thread({ id: "t-b", agentId: "claude", imChannel: { platform: "lark", chatId: "oc_x" } }),
		]);
		expect(findThreadBoundToImChannel(d, "lark", "oc_x")).toEqual({ threadId: "t-b", agentId: "claude" });
	});

	it("returns null when no thread is bound to that chat", () => {
		const d = data([thread({ id: "t-a", imChannel: { platform: "lark", chatId: "oc_other" } })]);
		expect(findThreadBoundToImChannel(d, "lark", "oc_x")).toBeNull();
	});

	it("does not match a same chatId on a different platform", () => {
		const d = data([thread({ id: "t-a", imChannel: { platform: "dingtalk", chatId: "oc_x" } })]);
		expect(findThreadBoundToImChannel(d, "lark", "oc_x")).toBeNull();
	});

	it("returns the first thread when two are bound to the same chat", () => {
		const d = data([
			thread({ id: "first", imChannel: { platform: "lark", chatId: "oc_x" } }),
			thread({ id: "second", imChannel: { platform: "lark", chatId: "oc_x" } }),
		]);
		expect(findThreadBoundToImChannel(d, "lark", "oc_x")?.threadId).toBe("first");
	});
});
