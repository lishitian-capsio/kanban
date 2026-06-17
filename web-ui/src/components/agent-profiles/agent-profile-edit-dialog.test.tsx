import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentProfileEditDialog } from "./agent-profile-edit-dialog";

vi.mock("@/components/agent-profiles/use-agent-profile-model-data", () => ({
	useAgentProfileModelData: () => ({
		providerCatalog: [],
		providerModels: [],
		isLoadingCatalog: false,
		isLoadingModels: false,
		modelOptions: [],
		recommendedModelIds: [],
		shouldPinSelectedModelToTop: false,
		reasoningEnabledModelIds: [],
	}),
}));

vi.mock("@/components/detail-panels/kanban-chat-model-selector", () => ({
	KanbanChatModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock("@/components/detail-panels/kanban-model-picker-options", () => ({
	buildKanbanSelectedModelButtonText: () => "Select model",
}));

vi.mock("@/components/ui/native-select", () => ({
	NativeSelect: ({ children, ...props }: React.ComponentProps<"select">) => <select {...props}>{children}</select>,
}));

describe("AgentProfileEditDialog", () => {
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

	const hasExactText = (label: string): boolean =>
		Array.from(document.querySelectorAll("span")).some((el) => el.textContent?.trim() === label);

	it("renders no provider-definition fields (base URL / API key / region / GCP)", () => {
		act(() => {
			root.render(
				<AgentProfileEditDialog
					open
					onOpenChange={() => {}}
					workspaceId={null}
					profile={null}
					existingNames={[]}
					onCreate={async () => ({ ok: true })}
					onUpdate={async () => ({ ok: true })}
				/>,
			);
		});

		const text = document.body.textContent ?? "";
		expect(text.includes("Base URL")).toBe(false);
		expect(text.includes("API key")).toBe(false);
		expect(text.includes("GCP project ID")).toBe(false);
		expect(hasExactText("Provider")).toBe(true);
		expect(hasExactText("Model")).toBe(true);
	});
});
