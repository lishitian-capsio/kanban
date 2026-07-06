import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomeThreadCreateDialog } from "@/components/home-agent/home-thread-create-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentDefinition } from "@/runtime/types";

// The prompt composer reaches for the runtime tRPC client to power its `@` file
// mentions and `/` slash commands. Hoist mockable query fns so each test can
// drive the completion data sources without a live runtime.
const {
	searchFilesMock,
	getKanbanSlashCommandsMock,
	writeWorkspaceAttachmentMock,
	deleteWorkspaceAttachmentScopeMock,
} = vi.hoisted(() => ({
	searchFilesMock: vi.fn(),
	getKanbanSlashCommandsMock: vi.fn(),
	writeWorkspaceAttachmentMock: vi.fn(),
	deleteWorkspaceAttachmentScopeMock: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: { searchFiles: { query: searchFilesMock } },
		runtime: {
			getKanbanSlashCommands: { query: getKanbanSlashCommandsMock },
			writeWorkspaceAttachment: { mutate: writeWorkspaceAttachmentMock },
			deleteWorkspaceAttachmentScope: { mutate: deleteWorkspaceAttachmentScopeMock },
		},
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

function makeTextFile(name = "notes.txt"): File {
	return new File([new Uint8Array([104, 101, 108, 108, 111])], name, { type: "text/plain" });
}

function dispatchFileDrop(target: HTMLElement, file: File): void {
	const event = new Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: {
			items: [{ kind: "file", type: file.type, getAsFile: () => file }],
			files: [file],
			types: ["Files"],
		},
	});
	target.dispatchEvent(event);
}

// FileReader + the upload mutation both resolve asynchronously; give the microtask
// queue a couple of macrotasks to settle before asserting on the injected mention.
const flushAttachment = () => new Promise((resolve) => setTimeout(resolve, 30));

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
		writeWorkspaceAttachmentMock.mockResolvedValue({ ok: true, path: "/repo/.kanban/attachments/abc.txt" });
		deleteWorkspaceAttachmentScopeMock.mockResolvedValue({ ok: true });
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

	it("does not surface `/` slash commands (they are disabled in this dialog)", async () => {
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

		// Slash completion is opt-in and left off here, so typing `/` never queries
		// commands and no menu appears — while `@` mentions (below) stay available.
		expect(getKanbanSlashCommandsMock).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("/compact");
	});

	it("uploads a dropped non-image file, injects an @/path mention, and shows a removable chip", async () => {
		await render({ workspaceId: "ws-1" });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});

		// The bytes are persisted via the workspace-scoped mutation (never the
		// task-session one — there is no session yet), scoped to the client-generated
		// thread id so the created thread later owns and cleans them up.
		expect(writeWorkspaceAttachmentMock).toHaveBeenCalledWith(
			expect.objectContaining({ name: "notes.txt", scopeId: expect.any(String) }),
		);
		expect(writeWorkspaceAttachmentMock.mock.calls[0]?.[0]?.scopeId).toBeTruthy();
		// The returned absolute path is injected into the opening prompt as a mention.
		expect(textarea.value).toContain("@/repo/.kanban/attachments/abc.txt");
		// A removable chip shows the original filename.
		expect(document.body.textContent).toContain("notes.txt");

		// Removing the chip strips the injected mention back out of the prompt.
		const removeButton = document.querySelector('button[aria-label="Remove notes.txt"]');
		expect(removeButton).not.toBeNull();
		await act(async () => {
			removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(textarea.value).not.toContain("@/repo/.kanban/attachments/abc.txt");
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
	});

	it("submits with the same threadId used to scope the upload, and does not delete the scope", async () => {
		const onCreate = vi.fn(async () => {});
		const onOpenChange = vi.fn();
		await render({ workspaceId: "ws-1", onCreate, onOpenChange });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});
		const uploadScopeId = writeWorkspaceAttachmentMock.mock.calls[0]?.[0]?.scopeId as string;
		expect(uploadScopeId).toBeTruthy();

		await act(async () => {
			setControlledValue(textarea, "Do the thing");
			await flush();
		});
		const createButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Create",
		);
		await act(async () => {
			createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		// The thread adopts the id that scoped the pre-session upload.
		expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ threadId: uploadScopeId }));
		// Submitting must NOT clean up the scope — the new thread owns it now.
		expect(deleteWorkspaceAttachmentScopeMock).not.toHaveBeenCalled();
	});

	it("deletes the attachments scope when cancelled after uploading (no orphan)", async () => {
		const onOpenChange = vi.fn();
		await render({ workspaceId: "ws-1", onOpenChange });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});
		const uploadScopeId = writeWorkspaceAttachmentMock.mock.calls[0]?.[0]?.scopeId as string;

		// Cancel the dialog.
		const cancelButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel",
		);
		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});

		expect(deleteWorkspaceAttachmentScopeMock).toHaveBeenCalledWith({ scopeId: uploadScopeId });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("does not attach files when the selected agent has no `@/path` support", async () => {
		const codexAgents: RuntimeAgentDefinition[] = [
			{
				id: "codex",
				label: "Codex",
				binary: "codex",
				command: "codex",
				defaultArgs: [],
				installed: true,
				configured: true,
				resolvedExecutablePath: null,
			},
		];
		await render({ workspaceId: "ws-1", agents: codexAgents, defaultAgentId: "codex" });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});

		// Non-supporting agent: the file channel is inert, no upload, no chip.
		expect(writeWorkspaceAttachmentMock).not.toHaveBeenCalled();
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
	});

	it("does not attach files without a workspace scope", async () => {
		await render();

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});

		expect(writeWorkspaceAttachmentMock).not.toHaveBeenCalled();
	});
});
