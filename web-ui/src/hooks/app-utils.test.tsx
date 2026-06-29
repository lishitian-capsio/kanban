import { describe, expect, it } from "vitest";

import {
	buildDetailTaskUrl,
	buildFileUrl,
	buildFullscreenChatUrl,
	parseDetailTaskIdFromSearch,
	parseFileIdFromSearch,
	parseFullscreenChatTabFromSearch,
} from "@/hooks/app-utils";

describe("parseDetailTaskIdFromSearch", () => {
	it("returns the selected task id when present", () => {
		expect(parseDetailTaskIdFromSearch("?task=task-123")).toBe("task-123");
	});

	it("returns null when the task id is missing or blank", () => {
		expect(parseDetailTaskIdFromSearch("")).toBeNull();
		expect(parseDetailTaskIdFromSearch("?task=")).toBeNull();
		expect(parseDetailTaskIdFromSearch("?task=%20%20")).toBeNull();
	});
});

describe("buildDetailTaskUrl", () => {
	it("adds the task id while preserving other query params and hash", () => {
		expect(
			buildDetailTaskUrl({
				pathname: "/project-1",
				search: "?view=board",
				hash: "#panel",
				taskId: "task-123",
			}),
		).toBe("/project-1?view=board&task=task-123#panel");
	});

	it("removes the task id while preserving other query params", () => {
		expect(
			buildDetailTaskUrl({
				pathname: "/project-1",
				search: "?view=board&task=task-123",
				hash: "",
				taskId: null,
			}),
		).toBe("/project-1?view=board");
	});
});

describe("parseFullscreenChatTabFromSearch", () => {
	it("returns the active fullscreen chat tab when present", () => {
		expect(parseFullscreenChatTabFromSearch("?chat=home")).toBe("home");
		expect(parseFullscreenChatTabFromSearch("?chat=pi")).toBe("pi");
		expect(parseFullscreenChatTabFromSearch("?chat=thread-abc")).toBe("thread-abc");
	});

	it("returns null when the chat tab is missing or blank", () => {
		expect(parseFullscreenChatTabFromSearch("")).toBeNull();
		expect(parseFullscreenChatTabFromSearch("?task=task-1")).toBeNull();
		expect(parseFullscreenChatTabFromSearch("?chat=")).toBeNull();
		expect(parseFullscreenChatTabFromSearch("?chat=%20%20")).toBeNull();
	});
});

describe("buildFullscreenChatUrl", () => {
	it("adds the chat tab while preserving other query params and hash", () => {
		expect(
			buildFullscreenChatUrl({
				pathname: "/project-1",
				search: "?view=board",
				hash: "#panel",
				chatTab: "pi",
			}),
		).toBe("/project-1?view=board&chat=pi#panel");
	});

	it("removes the chat tab while preserving other query params", () => {
		expect(
			buildFullscreenChatUrl({
				pathname: "/project-1",
				search: "?chat=thread-abc&task=task-1",
				hash: "",
				chatTab: null,
			}),
		).toBe("/project-1?task=task-1");
	});
});

describe("parseFileIdFromSearch", () => {
	it("returns the open file id when present", () => {
		expect(parseFileIdFromSearch("?file=doc-123")).toBe("doc-123");
	});

	it("returns null when the file id is missing or blank", () => {
		expect(parseFileIdFromSearch("")).toBeNull();
		expect(parseFileIdFromSearch("?task=task-1")).toBeNull();
		expect(parseFileIdFromSearch("?file=")).toBeNull();
		expect(parseFileIdFromSearch("?file=%20%20")).toBeNull();
	});
});

describe("buildFileUrl", () => {
	it("adds the file id while preserving other query params and hash", () => {
		expect(
			buildFileUrl({
				pathname: "/project-1",
				search: "?task=task-1",
				hash: "#panel",
				fileId: "doc-123",
			}),
		).toBe("/project-1?task=task-1&file=doc-123#panel");
	});

	it("removes the file id while preserving other query params", () => {
		expect(
			buildFileUrl({
				pathname: "/project-1",
				search: "?file=doc-123&task=task-1",
				hash: "",
				fileId: null,
			}),
		).toBe("/project-1?task=task-1");
	});
});
