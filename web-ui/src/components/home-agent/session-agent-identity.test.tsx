import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveHomeSessionCardStatus } from "@/components/home-agent/home-session-card-derive";
import { SessionAgentIdentity } from "@/components/home-agent/session-agent-identity";
import type { RuntimeAgentDefinition, RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "@/runtime/types";

const AGENTS = [
	{ id: "claude", label: "Claude", binary: "", command: "", defaultArgs: [], installed: true, configured: true },
] as unknown as RuntimeAgentDefinition[];

function summary(state: RuntimeTaskSessionState): RuntimeTaskSessionSummary {
	return {
		taskId: "t",
		state,
		agentId: null,
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
	};
}

describe("SessionAgentIdentity", () => {
	let container: HTMLDivElement;
	let root: Root;
	let prev: boolean | undefined;

	beforeEach(() => {
		prev = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prev;
	});

	function render(props: { state: RuntimeTaskSessionState; isActive: boolean; variant?: "card" | "tab" }) {
		act(() => {
			root.render(
				<SessionAgentIdentity
					agents={AGENTS}
					agentId="claude"
					status={deriveHomeSessionCardStatus(summary(props.state))}
					title="Refactor auth"
					isActive={props.isActive}
					variant={props.variant ?? "tab"}
				/>,
			);
		});
	}

	function byAriaLabel(label: string): HTMLElement | null {
		return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	}

	it("renders the agent avatar (hover-named) leading the title", () => {
		render({ state: "idle", isActive: false });
		expect(byAriaLabel("Claude")).not.toBeNull();
		expect(container.textContent).toContain("Refactor auth");
	});

	it("renders a status badge for every variant — including the tab strip that previously lacked one", () => {
		render({ state: "running", isActive: true, variant: "tab" });
		const marker = byAriaLabel("Running");
		expect(marker).not.toBeNull();
		expect(marker?.querySelector("svg.animate-spin")).not.toBeNull();
	});

	it("renders an idle dot status marker", () => {
		render({ state: "idle", isActive: false });
		expect(byAriaLabel("Idle")).not.toBeNull();
	});

	it("makes the title bold + primary when active and normal + secondary when not", () => {
		// The title is the truncating span; the outer wrapper shares its textContent.
		render({ state: "idle", isActive: true });
		let title = container.querySelector<HTMLElement>("span.truncate");
		expect(title?.textContent).toBe("Refactor auth");
		expect(title?.className).toContain("font-medium");
		expect(title?.className).toContain("text-text-primary");

		render({ state: "idle", isActive: false });
		title = container.querySelector<HTMLElement>("span.truncate");
		expect(title?.className).toContain("font-normal");
		expect(title?.className).toContain("text-text-secondary");
	});
});
