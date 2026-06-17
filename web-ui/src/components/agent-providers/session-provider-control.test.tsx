import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProviderControl } from "./session-provider-control";

const providerSet = {
	providers: [
		{ agentId: "pi", provider: "anthropic", model: "claude-x" },
		{ agentId: "pi", provider: "openai", model: "gpt-5" },
	],
	defaultProviderId: "anthropic",
	isLoading: false,
	reload: () => {},
};

vi.mock("@/hooks/use-agent-provider-set", () => ({
	providerIdOfConfig: (config: { provider?: string }) => (config.provider ?? "").trim(),
	useAgentProviderSet: () => providerSet,
}));

describe("SessionProviderControl", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	function trigger(): HTMLButtonElement {
		const el = container.querySelector('button[aria-label="Switch session provider"]');
		if (!el) {
			throw new Error("provider switch trigger not found");
		}
		return el as HTMLButtonElement;
	}

	it("renders nothing without an agent", () => {
		act(() => {
			root.render(
				<SessionProviderControl
					workspaceId="ws"
					agentId={null}
					selectedProviderId={null}
					onSelectProvider={() => {}}
				/>,
			);
		});
		expect(container.querySelector("button")).toBeNull();
	});

	it("shows the agent default when no provider is selected for the session", () => {
		act(() => {
			root.render(
				<SessionProviderControl
					workspaceId="ws"
					agentId="pi"
					selectedProviderId={null}
					onSelectProvider={() => {}}
				/>,
			);
		});
		expect(trigger().textContent).toContain("anthropic");
	});

	it("shows the explicit per-session selection over the default", () => {
		act(() => {
			root.render(
				<SessionProviderControl
					workspaceId="ws"
					agentId="pi"
					selectedProviderId="openai"
					onSelectProvider={() => {}}
				/>,
			);
		});
		expect(trigger().textContent).toContain("openai");
	});

	it("lists providers and fires onSelectProvider on pick — with no create/edit affordance", () => {
		const onSelectProvider = vi.fn();
		act(() => {
			root.render(
				<SessionProviderControl
					workspaceId="ws"
					agentId="pi"
					selectedProviderId={null}
					onSelectProvider={onSelectProvider}
				/>,
			);
		});
		act(() => {
			trigger().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
			trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		// Radix renders the menu in a portal on document.body.
		const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
		const labels = menuItems.map((item) => item.textContent ?? "");
		expect(labels.some((l) => l.includes("anthropic"))).toBe(true);
		expect(labels.some((l) => l.includes("openai"))).toBe(true);
		// Select-only: nothing offers to create/edit/delete a provider.
		expect(labels.some((l) => /new|edit|rename|duplicate|delete/i.test(l))).toBe(false);

		const openaiItem = menuItems.find((item) => (item.textContent ?? "").includes("openai"));
		act(() => {
			openaiItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onSelectProvider).toHaveBeenCalledWith("openai");
	});
});
