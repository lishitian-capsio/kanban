import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentDefinition } from "@/runtime/types";

// TaskPromptComposer imports the runtime tRPC client at module load for its file
// @-mention completion. This dialog disables mentions (no workspace scope), so the
// client is never invoked — stub it to keep the test hermetic regardless.
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ workspace: { searchFiles: { query: vi.fn(async () => ({ files: [] })) } } }),
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

describe("HomeThreadCreateDialog images", () => {
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

	it("shows a thumbnail for a pasted image and forwards it to onCreate", async () => {
		const onCreate = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<TooltipProvider>
					<HomeThreadCreateDialog
						open
						onOpenChange={() => {}}
						agents={agents}
						defaultAgentId="claude"
						onCreate={onCreate}
					/>
				</TooltipProvider>,
			);
			await flush();
		});

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
});
