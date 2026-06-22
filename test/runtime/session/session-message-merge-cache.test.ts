import { describe, expect, it, vi } from "vitest";

import type { SessionMessage } from "../../../src/session/session-message";
import { SessionMessageMergeCache } from "../../../src/session/session-message-merge-cache";

function message(id: string, content = "", role: SessionMessage["role"] = "assistant"): SessionMessage {
	return { id, role, content, createdAt: 1 };
}

describe("SessionMessageMergeCache", () => {
	it("merges persisted and live on the first resolve", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => [message("p1", "persisted")]);

		const merged = await cache.resolve("t1", 1, [message("l1", "live")], loadPersisted);

		expect(merged.map((m) => m.id)).toEqual(["p1", "l1"]);
		expect(loadPersisted).toHaveBeenCalledTimes(1);
	});

	it("returns the cached result without re-reading persistence when nothing changed", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => [message("p1")]);
		const live = [message("l1", "hi")];

		const first = await cache.resolve("t1", 1, live, loadPersisted);
		const second = await cache.resolve("t1", 1, live, loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it("recomputes when the persisted generation changes", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => [message("p1")]);

		await cache.resolve("t1", 1, [message("l1")], loadPersisted);
		await cache.resolve("t1", 2, [message("l1")], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(2);
	});

	it("recomputes and includes the new message when a live message is appended", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => []);

		await cache.resolve("t1", 1, [message("l1", "a")], loadPersisted);
		const merged = await cache.resolve("t1", 1, [message("l1", "a"), message("l2", "b")], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(2);
		expect(merged.map((m) => m.id)).toEqual(["l1", "l2"]);
	});

	it("recomputes when the trailing live message content grows (streaming tail)", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => []);

		await cache.resolve("t1", 1, [message("stream", "x")], loadPersisted);
		const merged = await cache.resolve("t1", 1, [message("stream", "xxxx")], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(2);
		expect(merged[0]?.content).toBe("xxxx");
	});

	it("recomputes when the trailing live content changes without changing length", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => []);

		await cache.resolve("t1", 1, [message("stream", "abcd")], loadPersisted);
		const merged = await cache.resolve("t1", 1, [message("stream", "wxyz")], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(2);
		expect(merged[0]?.content).toBe("wxyz");
	});

	it("caches an empty live buffer against persisted history (restart read-back)", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => [message("p1"), message("p2")]);

		const first = await cache.resolve("t1", 0, [], loadPersisted);
		const second = await cache.resolve("t1", 0, [], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(1);
		expect(first.map((m) => m.id)).toEqual(["p1", "p2"]);
		expect(second).toBe(first);
	});

	it("isolates cache entries per taskId", async () => {
		const cache = new SessionMessageMergeCache();
		const loadPersisted = vi.fn(async () => []);

		await cache.resolve("t1", 1, [message("a")], loadPersisted);
		await cache.resolve("t2", 1, [message("a")], loadPersisted);

		expect(loadPersisted).toHaveBeenCalledTimes(2);
	});
});
