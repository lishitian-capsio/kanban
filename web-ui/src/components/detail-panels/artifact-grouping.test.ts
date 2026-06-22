import { describe, expect, it } from "vitest";

import type { RuntimeArtifact } from "@/runtime/types";
import { groupArtifactsByType, resolveArtifactIconKind } from "./artifact-grouping";

function artifact(overrides: Partial<RuntimeArtifact> & Pick<RuntimeArtifact, "path">): RuntimeArtifact {
	return {
		type: "other",
		label: "Other",
		status: "new",
		previewKind: "markdown",
		...overrides,
	};
}

describe("groupArtifactsByType", () => {
	it("groups by type and preserves member order, pushing Other last", () => {
		const groups = groupArtifactsByType([
			artifact({ path: "out/x.json", type: "other", label: "Other", previewKind: "json" }),
			artifact({ path: "docs/plan/a.md", type: "plan", label: "Plan" }),
			artifact({ path: "docs/plan/b.md", type: "plan", label: "Plan" }),
			artifact({ path: "docs/customer/c.md", type: "customer", label: "Customer" }),
		]);

		expect(groups.map((g) => g.type)).toEqual(["customer", "plan", "other"]);
		expect(groups.find((g) => g.type === "plan")?.artifacts.map((a) => a.path)).toEqual([
			"docs/plan/a.md",
			"docs/plan/b.md",
		]);
	});

	it("returns an empty array for no artifacts", () => {
		expect(groupArtifactsByType([])).toEqual([]);
	});
});

describe("resolveArtifactIconKind", () => {
	it("derives an icon bucket from preview kind and extension", () => {
		expect(resolveArtifactIconKind({ previewKind: "markdown", path: "a.md" })).toBe("markdown");
		expect(resolveArtifactIconKind({ previewKind: "image", path: "a.png" })).toBe("image");
		expect(resolveArtifactIconKind({ previewKind: "json", path: "a.json" })).toBe("json");
		expect(resolveArtifactIconKind({ previewKind: "binary", path: "a.pdf" })).toBe("binary");
		expect(resolveArtifactIconKind({ previewKind: "text", path: "a.csv" })).toBe("table");
		expect(resolveArtifactIconKind({ previewKind: "text", path: "a.txt" })).toBe("text");
	});
});
