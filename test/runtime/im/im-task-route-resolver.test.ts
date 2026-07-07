import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeHomeChatThread,
	RuntimeHomeChatThreadsData,
} from "../../../src/core/api-contract";
import { DEFAULT_HOME_THREAD_ID } from "../../../src/core/home-agent-session";
import {
	findThreadBoundToImChannel,
	resolveHomeSessionImChannel,
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

	it("resolves the doc-level pi binding as the pi default session (decision X1)", () => {
		const d: RuntimeHomeChatThreadsData = { threads: [], piImChannel: { platform: "lark", chatId: "oc_pi" } };
		expect(findThreadBoundToImChannel(d, "lark", "oc_pi")).toEqual({
			threadId: DEFAULT_HOME_THREAD_ID,
			agentId: "pi",
		});
	});

	it("prefers a matching thread over the pi binding", () => {
		const d: RuntimeHomeChatThreadsData = {
			threads: [thread({ id: "t-a", agentId: "claude", imChannel: { platform: "lark", chatId: "oc_x" } })],
			piImChannel: { platform: "lark", chatId: "oc_x" },
		};
		expect(findThreadBoundToImChannel(d, "lark", "oc_x")).toEqual({ threadId: "t-a", agentId: "claude" });
	});
});

describe("resolveHomeSessionImChannel", () => {
	it("resolves a pi reply to the doc-level pi binding regardless of threadId", () => {
		const d: RuntimeHomeChatThreadsData = { threads: [], piImChannel: { platform: "lark", chatId: "oc_pi" } };
		expect(resolveHomeSessionImChannel(d, "pi", DEFAULT_HOME_THREAD_ID)).toEqual({
			platform: "lark",
			chatId: "oc_pi",
		});
	});

	it("resolves a non-pi reply to its thread's binding, never the pi channel", () => {
		const d: RuntimeHomeChatThreadsData = {
			threads: [
				{
					id: "thread-9",
					agentId: "claude",
					name: "T",
					titleSource: "manual",
					createdAt: 1,
					updatedAt: 1,
					imChannel: { platform: "dingtalk", chatId: "cid" },
				},
			],
			piImChannel: { platform: "lark", chatId: "oc_pi" },
		};
		expect(resolveHomeSessionImChannel(d, "claude", "thread-9")).toEqual({ platform: "dingtalk", chatId: "cid" });
		// A browser-driven CLI default session (threadId "default", no thread entry) must NOT
		// mis-route to the pi channel.
		expect(resolveHomeSessionImChannel(d, "claude", DEFAULT_HOME_THREAD_ID)).toBeNull();
	});
});
