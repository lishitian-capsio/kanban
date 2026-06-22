import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeTaskWorkspaceMetadata, RuntimeWorkspaceMetadata } from "@/runtime/types";
import {
	replaceWorkspaceMetadata,
	resetWorkspaceMetadataStore,
	subscribeToAnyTaskMetadata,
} from "@/stores/workspace-metadata-store";

function makeTask(taskId: string, overrides: Partial<RuntimeTaskWorkspaceMetadata> = {}): RuntimeTaskWorkspaceMetadata {
	return {
		taskId,
		path: `/tmp/${taskId}`,
		exists: true,
		baseRef: "main",
		branch: `kanban/task/${taskId}`,
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 1,
		additions: 2,
		deletions: 0,
		stateVersion: 1,
		...overrides,
	};
}

function makeMetadata(taskWorkspaces: RuntimeTaskWorkspaceMetadata[]): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces,
	};
}

describe("replaceWorkspaceMetadata per-task change detection", () => {
	let emitted: string[];
	let unsubscribe: () => void;

	beforeEach(() => {
		resetWorkspaceMetadataStore();
		emitted = [];
		unsubscribe = subscribeToAnyTaskMetadata((taskId) => {
			emitted.push(taskId);
		});
	});

	afterEach(() => {
		unsubscribe();
		resetWorkspaceMetadataStore();
	});

	it("emits for every task on the initial population", () => {
		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b"), makeTask("c")]));
		expect(new Set(emitted)).toEqual(new Set(["a", "b", "c"]));
	});

	it("emits only for the task that actually changed, never for unchanged peers", () => {
		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b"), makeTask("c")]));
		emitted = [];

		// "a" and "c" are byte-identical; only "b" changes (new head commit + diff counts + version).
		replaceWorkspaceMetadata(
			makeMetadata([
				makeTask("a"),
				makeTask("b", { headCommit: "def456", changedFiles: 5, stateVersion: 2 }),
				makeTask("c"),
			]),
		);

		expect(emitted).toEqual(["b"]);
	});

	it("emits for a removed task (present previously, absent from the incoming snapshot)", () => {
		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b")]));
		emitted = [];

		replaceWorkspaceMetadata(makeMetadata([makeTask("a")]));

		expect(emitted).toEqual(["b"]);
	});

	it("emits nothing when the incoming snapshot is identical", () => {
		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b")]));
		emitted = [];

		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b")]));

		expect(emitted).toEqual([]);
	});

	it("emits for a newly added task without disturbing existing unchanged tasks", () => {
		replaceWorkspaceMetadata(makeMetadata([makeTask("a")]));
		emitted = [];

		replaceWorkspaceMetadata(makeMetadata([makeTask("a"), makeTask("b")]));

		expect(emitted).toEqual(["b"]);
	});
});
