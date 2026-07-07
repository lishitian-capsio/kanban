import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

const {
	searchFilesMock,
	getKanbanSlashCommandsMock,
	writeWorkspaceAttachmentMock,
	deleteWorkspaceAttachmentScopeMock,
	showAppToastMock,
} = vi.hoisted(() => ({
	searchFilesMock: vi.fn(),
	getKanbanSlashCommandsMock: vi.fn(),
	writeWorkspaceAttachmentMock: vi.fn(),
	deleteWorkspaceAttachmentScopeMock: vi.fn(),
	showAppToastMock: vi.fn(),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
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

// The agent/model picker fetches provider data; stub it out so the dialog renders
// without a live runtime. The attachment behavior under test is independent of it.
vi.mock("@/components/task-agent-model-picker", () => ({
	TaskAgentModelPicker: () => null,
	useTaskAgentModelPicker: () => ({
		agentOptions: [],
		kanbanProviderOptions: [],
		kanbanModelOptions: [],
		effectiveDefaultModelId: null,
		effectiveDefaultProviderId: null,
		providerModels: [],
		isLoadingProviders: false,
		isLoadingModels: false,
		providerDefaultModels: {},
	}),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const flushAttachment = () => new Promise((resolve) => setTimeout(resolve, 30));

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

describe("TaskCreateDialog attachments", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		searchFilesMock.mockResolvedValue({ files: [] });
		getKanbanSlashCommandsMock.mockResolvedValue({ commands: [] });
		writeWorkspaceAttachmentMock.mockResolvedValue({
			ok: true,
			path: "/repo/.kanban/attachments/task-xyz/notes-1.txt",
		});
		deleteWorkspaceAttachmentScopeMock.mockResolvedValue({ ok: true });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	function render(props: Partial<React.ComponentProps<typeof TaskCreateDialog>> = {}) {
		return act(async () => {
			root.render(
				<TooltipProvider>
					<TaskCreateDialog
						open
						onOpenChange={() => {}}
						prompt=""
						onPromptChange={() => {}}
						images={[]}
						onImagesChange={() => {}}
						onCreate={vi.fn(() => "task-xyz")}
						onCreateMultiple={vi.fn(() => [])}
						startInPlanMode={false}
						onStartInPlanModeChange={() => {}}
						autoReviewEnabled={false}
						onAutoReviewEnabledChange={() => {}}
						autoReviewMode="commit"
						onAutoReviewModeChange={() => {}}
						workspaceId="ws-1"
						taskId="task-xyz"
						agentId="claude"
						branchRef="main"
						branchOptions={[{ label: "main", value: "main" }]}
						onBranchRefChange={() => {}}
						{...props}
					/>
				</TooltipProvider>,
			);
			await flush();
		});
	}

	it("uploads a dropped non-image file scoped to the task id and shows a removable chip without injecting a mention", async () => {
		await render();

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea).not.toBeNull();

		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});

		// Persisted via the workspace mutation, scoped to the pre-minted task id (so
		// the file relocates into that task's worktree at start).
		expect(writeWorkspaceAttachmentMock).toHaveBeenCalledWith(
			expect.objectContaining({ name: "notes.txt", scopeId: "task-xyz" }),
		);
		// The prompt is NOT mutated at upload time — the backend injects the `@/path`
		// mention at task start once the worktree exists.
		expect(textarea.value).toBe("");
		// A removable chip shows the original filename.
		expect(document.body.textContent).toContain("notes.txt");
		const removeButton = document.querySelector('button[aria-label="Remove notes.txt"]');
		expect(removeButton).not.toBeNull();
		await act(async () => {
			removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await flush();
		});
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
	});

	it("does not attach files when the selected agent has no `@/path` support, but surfaces a clear hint and toast instead of silently ignoring the drop", async () => {
		await render({ agentId: "codex" });

		// A discoverable static hint before the user even tries.
		expect(document.body.textContent).toContain("Switch to Claude to attach files");

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});

		expect(writeWorkspaceAttachmentMock).not.toHaveBeenCalled();
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
		// The drop is not swallowed silently — the user is told why + how to fix it.
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "warning",
				message: expect.stringContaining("Switch to Claude"),
			}),
			"task-create-attachment-unsupported",
		);
	});

	it("drops staged attachments and warns when the selected agent is switched to one without support", async () => {
		await render({ agentId: "claude" });

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		await act(async () => {
			dispatchFileDrop(textarea, makeTextFile("notes.txt"));
			await flushAttachment();
		});
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).not.toBeNull();

		// Switch to an agent that can't consume the staged file.
		showAppToastMock.mockClear();
		await render({ agentId: "codex" });
		await act(async () => {
			await flushAttachment();
		});

		// The staged upload is cleaned up on the backend and the chip is gone.
		expect(deleteWorkspaceAttachmentScopeMock).toHaveBeenCalledWith({ scopeId: "task-xyz" });
		expect(document.querySelector('button[aria-label="Remove notes.txt"]')).toBeNull();
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "warning" }),
			"task-create-attachment-unsupported",
		);
	});
});
