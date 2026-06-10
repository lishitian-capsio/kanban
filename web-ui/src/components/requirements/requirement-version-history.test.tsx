import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeRequirementItem, RuntimeRequirementVersion } from "@/runtime/types";

import { RequirementVersionHistory } from "./requirement-version-history";

function makeSnapshot(overrides: Partial<RuntimeRequirementItem> = {}): RuntimeRequirementItem {
	return {
		id: "req-1",
		title: "Phone login",
		description: "",
		priority: "medium",
		status: "draft",
		linkedTaskIds: [],
		order: 0,
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

function makeVersion(version: number, overrides: Partial<RuntimeRequirementVersion> = {}): RuntimeRequirementVersion {
	return {
		requirementId: "req-1",
		version,
		changeKind: "update",
		snapshot: makeSnapshot(),
		source: "human",
		reason: null,
		createdAt: 1_700_000_000_000 + version,
		...overrides,
	};
}

describe("RequirementVersionHistory", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("renders each version in v1/v2 form, newest first", () => {
		const versions = [
			makeVersion(1, { changeKind: "create" }),
			makeVersion(2, { changeKind: "update" }),
			makeVersion(3, { changeKind: "revert", source: "agent" }),
		];
		act(() => {
			root.render(<RequirementVersionHistory versions={versions} isLoading={false} errorMessage={null} />);
		});

		const labels = Array.from(container.querySelectorAll("[data-testid='requirement-version-label']")).map(
			(node) => node.textContent,
		);
		// Newest (highest version) first.
		expect(labels).toEqual(["v3", "v2", "v1"]);
		expect(container.textContent).toContain("Reverted");
		expect(container.textContent).toContain("Created");
	});

	it("shows an empty state when there are no versions", () => {
		act(() => {
			root.render(<RequirementVersionHistory versions={[]} isLoading={false} errorMessage={null} />);
		});
		expect(container.querySelectorAll("[data-testid='requirement-version-label']")).toHaveLength(0);
		expect(container.textContent?.toLowerCase()).toContain("no version history");
	});

	it("shows the error message when loading fails", () => {
		act(() => {
			root.render(<RequirementVersionHistory versions={[]} isLoading={false} errorMessage="Boom" />);
		});
		expect(container.textContent).toContain("Boom");
	});
});
