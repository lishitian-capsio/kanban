import { describe, expect, it } from "vitest";

import { classifyGitRefDisposition } from "@/components/git-history/git-ref-classification";

describe("classifyGitRefDisposition", () => {
	it("treats the board data branch as visible but non-switchable", () => {
		expect(classifyGitRefDisposition("kanban/board", "branch")).toBe("non-switchable");
	});

	it("hides task branches", () => {
		expect(classifyGitRefDisposition("kanban/task/abc123", "branch")).toBe("hidden");
	});

	it("hides board-archive branches", () => {
		expect(classifyGitRefDisposition("kanban/board-archive/1718000000", "branch")).toBe("hidden");
	});

	it("leaves ordinary code branches switchable", () => {
		expect(classifyGitRefDisposition("main", "branch")).toBe("switchable");
		expect(classifyGitRefDisposition("feature/login", "branch")).toBe("switchable");
		expect(classifyGitRefDisposition("kanban/boardgame", "branch")).toBe("switchable");
	});

	it("applies the same rules to remote-tracking refs after stripping the remote name", () => {
		expect(classifyGitRefDisposition("origin/kanban/board", "remote")).toBe("non-switchable");
		expect(classifyGitRefDisposition("origin/kanban/task/abc123", "remote")).toBe("hidden");
		expect(classifyGitRefDisposition("origin/kanban/board-archive/1718000000", "remote")).toBe("hidden");
		expect(classifyGitRefDisposition("origin/main", "remote")).toBe("switchable");
	});

	it("handles remotes named something other than origin", () => {
		expect(classifyGitRefDisposition("upstream/kanban/board", "remote")).toBe("non-switchable");
		expect(classifyGitRefDisposition("fork/kanban/task/xyz", "remote")).toBe("hidden");
	});

	it("does not hide or lock detached HEAD refs", () => {
		expect(classifyGitRefDisposition("a1b2c3d", "detached")).toBe("switchable");
	});
});
