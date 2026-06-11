import { describe, expect, it } from "vitest";

import {
	parseHomeChatThreadCloseRequest,
	parseHomeChatThreadCreateRequest,
	parseHomeChatThreadRenameRequest,
	parseHookIngestRequest,
	parseTaskSessionStartRequest,
	parseWorkspaceFileSearchRequest,
} from "../../src/core/api-validation";

describe("parseWorkspaceFileSearchRequest", () => {
	it("parses q and limit", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "  src/runtime ", limit: "25" }));
		expect(parsed).toEqual({
			query: "src/runtime",
			limit: 25,
		});
	});

	it("treats missing q as empty query", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ limit: "10" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("does not accept legacy query alias", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ query: "legacy" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("throws when limit is invalid", () => {
		expect(() => {
			parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "board", limit: "0" }));
		}).toThrow("Invalid file search limit parameter.");
	});
});

describe("parseHookIngestRequest", () => {
	it("parses and trims task and workspace identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			workspaceId: "  workspace-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			workspaceId: "workspace-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				finalMessage: undefined,
				notificationType: undefined,
			},
		});
	});

	it("throws when workspaceId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				workspaceId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing workspaceId");
	});
});

describe("parseTaskSessionStartRequest", () => {
	it("parses resumeFromTrash and trims task identifiers", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "",
			baseRef: "  main  ",
			resumeFromTrash: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			baseRef: "main",
			resumeFromTrash: true,
		});
	});
});

describe("parseHomeChatThreadCreateRequest", () => {
	it("trims the name and passes agentId through", () => {
		expect(parseHomeChatThreadCreateRequest({ name: "  Planning  ", agentId: "pi" })).toEqual({
			name: "Planning",
			agentId: "pi",
		});
	});

	it("allows an omitted agentId", () => {
		expect(parseHomeChatThreadCreateRequest({ name: "Planning" })).toEqual({ name: "Planning" });
	});

	it("throws on an empty name", () => {
		expect(() => parseHomeChatThreadCreateRequest({ name: "   " })).toThrow("name cannot be empty");
	});
});

describe("parseHomeChatThreadRenameRequest", () => {
	it("trims id and name", () => {
		expect(parseHomeChatThreadRenameRequest({ id: "  t1 ", name: "  New " })).toEqual({
			id: "t1",
			name: "New",
		});
	});

	it("throws on empty id", () => {
		expect(() => parseHomeChatThreadRenameRequest({ id: "  ", name: "New" })).toThrow("id cannot be empty");
	});

	it("throws on empty name", () => {
		expect(() => parseHomeChatThreadRenameRequest({ id: "t1", name: " " })).toThrow("name cannot be empty");
	});
});

describe("parseHomeChatThreadCloseRequest", () => {
	it("trims the id", () => {
		expect(parseHomeChatThreadCloseRequest({ id: "  t1 " })).toEqual({ id: "t1" });
	});

	it("throws on empty id", () => {
		expect(() => parseHomeChatThreadCloseRequest({ id: "   " })).toThrow("id cannot be empty");
	});
});
