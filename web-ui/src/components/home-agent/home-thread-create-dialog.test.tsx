import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentDefinition } from "@/runtime/types";

// The prompt composer reaches for the runtime tRPC client to power its `@` file
// mentions and `/` slash commands. Hoist mockable query fns so each test can
// drive the completion data sources without a live runtime.
const { searchFilesMock, getKanbanSlashCommandsMock } = vi.hoisted(() => ({
	searchFilesMock: vi.fn(),
	getKanbanSlashCommandsMock: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: { searchFiles: { query: searchFilesMock } },
		runtime: { getKanbanSlashCommands: { query: getKanbanSlashCommandsMock } },
	}),
}));

const agents: RuntimeAgentDefinition[] = [
	{
		id: "claude",
		label: "Claude",
		binary: "claude",
		command: "claude",
		defaultArgs: [],
		installed: true,
		configured: true,
		resolvedExecutablePath: null,
	},
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// The completion data sources are debounced at 120ms; wait past that plus a rAF.
const flushCompletion = () => new Promise((resolve) => setTimeout(resolve, 180));

function makePngFile(): File {
	// A tiny non-empty PNG payload; the exact bytes are irrelevant, only that
	// FileReader produces a non-empty base64 data URL from it.
	const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
	return new File([bytes], "mock.png", { type: "image/png" });
}

function dispatchImagePaste(textarea: HTMLTextAreaElement, file: File): void {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			items: [{ kind: "file", type: file.type, getAsFile: () => file }],
			files: [file],
		},
	});
	textarea.dispatchEvent(event);
}

function setControlledValue(textarea: HTMLTextAreaElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	setter?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("HomeThreadCreateDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		searchFilesMock.mockResolvedValue({ files: [] });
		getKanbanSlashCommandsMock.mockResolvedValue({ commands: [] });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	function render(props: Partial<React.ComponentProps<typeof HomeThreadCreateDialog>> = {}) {
		return act(async () => {
			root.render(
				<TooltipProvider>
					<HomeThreadCreateDialog
						open
						onOpenChange={() => {}}
						agents={agents}
						defaultAgentId="claude"
						onCreate={vi.fn(async () => {})}
						{...props}
					/>
				</TooltipProvider>,
			);
			await flush();
		});
	}

	it("shows a thumbnail for a pasted image and forwards it to onCreate", async () => {
		const onCreate = vi.fn(async () => {});
		await render({ onCreate });

		const textarea = document.querySelector("textarea");
		expect(textarea).not.toBeNull();

		// Paste an image into the composer -> a thumbnail appears in the strip.
		await act(async () => {
			dispatchImagePaste(textarea as HTMLTextAreaElement, makePngFile());
			await flush();
		});

		const thumbnail = document.querySelector('img[alt="mock.png"]') as HTMLImageElement | null;
		expect(thumbnail).not.toBeNull();
		expect(thumbnail?.src.startsWith("data:image/png;base64,")).toBe(true);

		// Type the opening prompt, then create the thread.
		await act(async () => {
			setControlledValue(textarea as HTMLTextAreaElement, "Match this mockup");
			await flush();
		});

		const createButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Create",
		);
		expect(createButton).toBeTruthy();

		await act(async () => {
			createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		expect(onCreate).toHaveBeenCalledTimes(1);
		expect(onCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				description: "Match this mockup",
				agentId: "claude",
				images: expect.arrayContaining([expect.objectContaining({ mimeType: "image/png", name: "mock.png" })]),
			}),
		);
	});

	it("shows `@` file mentions from the workspace when a workspace is scoped", async () => {
		searchFilesMock.mockResolvedValue({ files: [{ name: "readme.md", path: "docs/readme.md" }] });
		await render({ workspaceId: "ws-1" });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			setControlledValue(textarea, "@read");
			await flushCompletion();
		});

		expect(searchFilesMock).toHaveBeenCalledWith(expect.objectContaining({ query: "read" }));
		expect(document.body.textContent).toContain("docs/readme.md");
	});

	it("shows `/` slash commands in the completion menu", async () => {
		getKanbanSlashCommandsMock.mockResolvedValue({
			commands: [{ name: "compact", description: "Compact the conversation" }],
		});
		await render({ workspaceId: "ws-1" });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			setControlledValue(textarea, "/comp");
			await flushCompletion();
		});

		expect(getKanbanSlashCommandsMock).toHaveBeenCalled();
		expect(document.body.textContent).toContain("/compact");
	});
});
