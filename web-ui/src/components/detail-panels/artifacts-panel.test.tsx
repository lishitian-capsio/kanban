import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeArtifact, RuntimeArtifactContentResponse } from "@/runtime/types";

const mockUseRuntimeArtifactContent = vi.fn();

vi.mock("@/runtime/use-runtime-artifact-content", () => ({
	useRuntimeArtifactContent: (...args: unknown[]) => mockUseRuntimeArtifactContent(...args),
}));

import { ArtifactsPanel } from "@/components/detail-panels/artifacts-panel";

function markdownContent(path: string, text: string): RuntimeArtifactContentResponse {
	return {
		path,
		previewKind: "markdown",
		text,
		data: null,
		mimeType: "text/markdown",
		size: text.length,
		truncated: false,
	};
}

function artifact(overrides: Partial<RuntimeArtifact> & Pick<RuntimeArtifact, "path">): RuntimeArtifact {
	return { type: "plan", label: "Plan", status: "new", previewKind: "markdown", ...overrides };
}

describe("ArtifactsPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockUseRuntimeArtifactContent.mockReturnValue({ content: null, isLoading: false, isError: false });
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockUseRuntimeArtifactContent.mockReset();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows the empty state when there are no artifacts", async () => {
		await act(async () => {
			root.render(
				<ArtifactsPanel taskId="task-1" workspaceId="ws-1" baseRef="main" artifacts={[]} isLoading={false} />,
			);
		});
		expect(container.textContent).toContain("暂无产物");
	});

	it("renders grouped artifacts and selects the first by default", async () => {
		mockUseRuntimeArtifactContent.mockReturnValue({
			content: markdownContent("docs/plan/a.md", "# Hello plan"),
			isLoading: false,
			isError: false,
		});
		await act(async () => {
			root.render(
				<ArtifactsPanel
					taskId="task-1"
					workspaceId="ws-1"
					baseRef="main"
					artifacts={[
						artifact({ path: "docs/plan/a.md" }),
						artifact({
							path: "out/r.json",
							type: "other",
							label: "Other",
							previewKind: "json",
							status: "modified",
						}),
					]}
					isLoading={false}
				/>,
			);
		});

		// Both group headers render.
		expect(container.textContent).toContain("Plan");
		expect(container.textContent).toContain("Other");
		// The first artifact's content is requested and previewed.
		const lastCall = mockUseRuntimeArtifactContent.mock.calls.at(-1);
		expect(lastCall).toEqual(["task-1", "ws-1", "main", "docs/plan/a.md"]);
		expect(container.textContent).toContain("Hello plan");
	});

	it("switches the viewed artifact when another row is clicked", async () => {
		mockUseRuntimeArtifactContent.mockReturnValue({ content: null, isLoading: false, isError: false });
		await act(async () => {
			root.render(
				<ArtifactsPanel
					taskId="task-1"
					workspaceId="ws-1"
					baseRef="main"
					artifacts={[artifact({ path: "docs/plan/a.md" }), artifact({ path: "docs/plan/b.md" })]}
					isLoading={false}
				/>,
			);
		});

		const rows = Array.from(container.querySelectorAll("button")).filter((button) =>
			button.textContent?.includes("b.md"),
		);
		expect(rows.length).toBeGreaterThan(0);
		await act(async () => {
			rows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const lastCall = mockUseRuntimeArtifactContent.mock.calls.at(-1);
		expect(lastCall).toEqual(["task-1", "ws-1", "main", "docs/plan/b.md"]);
	});
});
