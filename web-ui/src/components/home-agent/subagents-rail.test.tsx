import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentsRail } from "@/components/home-agent/subagents-rail";
import type { RuntimeConfigResponse, RuntimeTaskSessionSummary, RuntimeTaskSubagent } from "@/runtime/types";

const AGENTS = [
	{ id: "pi", label: "Kanban", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
] as unknown as RuntimeConfigResponse["agents"];

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "__home_agent__:ws:pi",
		state: "running",
		agentId: "pi",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		...overrides,
	};
}

function makeSubagent(overrides: Partial<RuntimeTaskSubagent> = {}): RuntimeTaskSubagent {
	return {
		subagentId: "sub-1",
		parentTaskId: "__home_agent__:ws:pi",
		sessionId: "pi-sub#__home_agent__:ws:pi#sub-1",
		label: "Investigate flaky test",
		status: "running",
		modelId: null,
		usage: null,
		startedAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("SubagentsRail", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(props: Partial<React.ComponentProps<typeof SubagentsRail>> = {}): void {
		act(() => {
			root.render(
				<SubagentsRail
					agents={AGENTS}
					mainSummary={makeSummary()}
					subagents={null}
					selectedSubagentId={null}
					onSelect={vi.fn()}
					orientation="fullscreen"
					{...props}
				/>,
			);
		});
	}

	it("always renders a Main row, and one row per subagent", () => {
		render({ subagents: [makeSubagent(), makeSubagent({ subagentId: "sub-2", label: "Write docs" })] });
		expect(container.textContent).toContain("Main");
		expect(container.textContent).toContain("Investigate flaky test");
		expect(container.textContent).toContain("Write docs");
	});

	it("renders only the Main row when there are no subagents", () => {
		render({ subagents: null });
		expect(container.textContent).toContain("Main");
		const rows = container.querySelectorAll("button");
		expect(rows).toHaveLength(1);
	});

	it("selecting the Main row calls onSelect(null); selecting a subagent calls onSelect(id)", () => {
		const onSelect = vi.fn();
		render({ subagents: [makeSubagent()], selectedSubagentId: "sub-1", onSelect });
		const buttons = [...container.querySelectorAll("button")];
		const mainRow = buttons.find((b) => b.textContent?.includes("Main")) as HTMLButtonElement;
		const subRow = buttons.find((b) => b.textContent?.includes("Investigate")) as HTMLButtonElement;
		act(() => mainRow.click());
		expect(onSelect).toHaveBeenCalledWith(null);
		act(() => subRow.click());
		expect(onSelect).toHaveBeenCalledWith("sub-1");
	});

	it("marks the active row via aria-pressed", () => {
		render({ subagents: [makeSubagent()], selectedSubagentId: "sub-1" });
		const subRow = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Investigate"),
		) as HTMLButtonElement;
		expect(subRow.getAttribute("aria-pressed")).toBe("true");
	});

	it("shows a token chip when a subagent reports usage", () => {
		render({
			subagents: [makeSubagent({ usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } })],
		});
		expect(container.textContent).toContain("1.5k");
	});
});
