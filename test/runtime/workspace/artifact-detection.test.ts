import { describe, expect, it } from "vitest";

import {
	type ArtifactChangeInput,
	classifyArtifactType,
	detectArtifacts,
	resolveArtifactPreviewKind,
} from "../../../src/workspace/artifact-detection";

describe("resolveArtifactPreviewKind", () => {
	it("maps markdown / image / json / text / binary extensions", () => {
		expect(resolveArtifactPreviewKind("docs/plan/a.md")).toBe("markdown");
		expect(resolveArtifactPreviewKind("out/diagram.PNG")).toBe("image");
		expect(resolveArtifactPreviewKind("data/report.json")).toBe("json");
		expect(resolveArtifactPreviewKind("data/rows.csv")).toBe("text");
		expect(resolveArtifactPreviewKind("notes/summary.txt")).toBe("text");
		expect(resolveArtifactPreviewKind("deliverable.pdf")).toBe("binary");
		expect(resolveArtifactPreviewKind("sheet.xlsx")).toBe("binary");
	});

	it("returns null for pure source code and config files", () => {
		expect(resolveArtifactPreviewKind("src/index.ts")).toBeNull();
		expect(resolveArtifactPreviewKind("web-ui/src/app.tsx")).toBeNull();
		expect(resolveArtifactPreviewKind("styles.css")).toBeNull();
		expect(resolveArtifactPreviewKind("package-lock.json".replace(".json", ".lock"))).toBeNull();
		expect(resolveArtifactPreviewKind("Makefile")).toBeNull();
		expect(resolveArtifactPreviewKind("noext")).toBeNull();
	});
});

describe("classifyArtifactType", () => {
	it("recognizes known convention paths", () => {
		expect(classifyArtifactType("docs/plan/feature.md")).toEqual({ type: "plan", label: "Plan" });
		expect(classifyArtifactType("docs/superpowers/specs/x.md")).toEqual({ type: "spec", label: "Spec" });
		expect(classifyArtifactType(".plan/docs/design.md")).toEqual({ type: "report", label: "Report" });
		expect(classifyArtifactType(".capsio/reports/daily.md")).toEqual({ type: "report", label: "Report" });
	});

	it("maps generic vault docs/<type>/ paths to that type", () => {
		expect(classifyArtifactType(".kanban/workspaces/w1/files/docs/requirement/r.md")).toEqual({
			type: "requirement",
			label: "Requirement",
		});
		expect(classifyArtifactType("docs/customer/acme.md")).toEqual({ type: "customer", label: "Customer" });
		expect(classifyArtifactType("docs/whatever-kind/x.md")).toEqual({
			type: "whatever-kind",
			label: "Whatever Kind",
		});
	});

	it("falls back to Other for unrecognized paths", () => {
		expect(classifyArtifactType("output/result.md")).toEqual({ type: "other", label: "Other" });
		expect(classifyArtifactType("docs/top-level.md")).toEqual({ type: "other", label: "Other" });
	});
});

describe("detectArtifacts", () => {
	function change(path: string, status: ArtifactChangeInput["status"]): ArtifactChangeInput {
		return { path, status };
	}

	it("keeps artifact files, classifies them, and maps status to new/modified", () => {
		const result = detectArtifacts([
			change("docs/plan/feature.md", "added"),
			change("src/index.ts", "modified"),
			change("report.json", "modified"),
			change("image.png", "untracked"),
			change("renamed.csv", "renamed"),
		]);

		// "Other"-labeled files (json/csv/png) sort before "Plan", each group by path.
		expect(result.map((a) => a.path)).toEqual(["image.png", "renamed.csv", "report.json", "docs/plan/feature.md"]);
		const plan = result.find((a) => a.path === "docs/plan/feature.md");
		expect(plan).toMatchObject({ type: "plan", label: "Plan", status: "new", previewKind: "markdown" });
		expect(result.find((a) => a.path === "report.json")).toMatchObject({ status: "modified", previewKind: "json" });
		expect(result.find((a) => a.path === "image.png")).toMatchObject({ status: "new", previewKind: "image" });
		expect(result.find((a) => a.path === "renamed.csv")).toMatchObject({ status: "modified", previewKind: "text" });
	});

	it("drops deleted files and non-artifact source files", () => {
		const result = detectArtifacts([
			change("docs/plan/gone.md", "deleted"),
			change("src/main.ts", "added"),
			change("yarn.lock", "modified"),
		]);
		expect(result).toEqual([]);
	});

	it("de-duplicates by path", () => {
		const result = detectArtifacts([change("a.md", "added"), change("a.md", "modified")]);
		expect(result).toHaveLength(1);
		expect(result[0]?.status).toBe("new");
	});
});
