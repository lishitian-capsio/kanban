import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopBar } from "@/components/top-bar";
import { fileSurfaceStore } from "@/components/file-surface";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/stores/workspace-metadata-store", () => ({
	useHomeGitSummaryValue: () => null,
	useTaskWorkspaceInfoValue: (taskId: string | null) => (taskId ? { branch: "task-1" } : null),
	useTaskWorkspaceSnapshotValue: () => null,
}));

// TopBar renders `FilePopover`, which lazy-loads the tRPC-backed filesystem
// explorer. Stub it so opening the popover in these tests stays lightweight.
vi.mock("@/components/file-surface/filesystem/file-system-explorer", () => ({
	FileSystemExplorer: () => <div data-testid="fs-explorer" />,
}));

function findFileToggle(container: HTMLElement): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>('[data-testid="toggle-file-surface-button"]');
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
	descriptor?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TopBar script shortcut onboarding", () => {
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
	});

	afterEach(() => {
		act(() => {
			// Reset the shared File-surface store so its URL-routed open state can't
			// leak between tests.
			fileSurfaceStore.closeLibrary();
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens first-shortcut dialog from Run and saves when command is provided", async () => {
		const onCreateFirstShortcut = vi.fn(async () => ({ ok: true }));
		const onRunShortcut = vi.fn();

		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					shortcuts={[]}
					onRunShortcut={onRunShortcut}
					onCreateFirstShortcut={onCreateFirstShortcut}
				/>,
			);
		});

		const runButton = findButtonByText(container, "Run");
		expect(runButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runButton?.click();
		});

		expect(document.body.textContent).toContain("Set up your first script shortcut");

		const commandInput = Array.from(document.body.querySelectorAll("input")).find(
			(input) => input.placeholder === "npm run dev",
		) as HTMLInputElement | undefined;
		expect(commandInput).toBeDefined();
		expect(commandInput?.value).toBe("");

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		expect(saveButton?.disabled).toBe(true);

		await act(async () => {
			if (!commandInput) {
				return;
			}
			setInputValue(commandInput, "pnpm dev");
		});
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			saveButton?.click();
		});

		expect(onCreateFirstShortcut).toHaveBeenCalledWith({
			label: "Run",
			command: "pnpm dev",
			icon: "play",
		});
		expect(onRunShortcut).not.toHaveBeenCalled();
	});

	it("opens settings when the runtime hint is clicked", async () => {
		const onOpenSettings = vi.fn();

		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					runtimeHint="No agent configured"
					onOpenSettings={onOpenSettings}
				/>,
			);
		});

		const runtimeHintButton = findButtonByText(container, "No agent configured");
		expect(runtimeHintButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			runtimeHintButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			runtimeHintButton?.click();
		});

		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("shows the selected task's owner after the branch control", async () => {
		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					shortcuts={[]}
					selectedTaskId="task-1"
					selectedTaskBaseRef="main"
					selectedTaskOwner={{ name: "Ada Lovelace", email: "ada@example.com" }}
				/>,
			);
		});

		const ownerBadge = Array.from(container.querySelectorAll("span")).find(
			(span) => span.getAttribute("title") === "Created by Ada Lovelace <ada@example.com>",
		);
		expect(ownerBadge).toBeDefined();
		expect(ownerBadge?.textContent).toContain("Ada Lovelace");
	});

	it("shows an icon-only File popover toggle in the right-side actions before Settings", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						shortcuts={[]}
						selectedTaskId="task-1"
						selectedTaskBaseRef="main"
						selectedTaskOwner={{ name: "Ada Lovelace", email: "ada@example.com" }}
						fileSurfaceWorkspaceId="ws-1"
						onOpenSettings={() => {}}
					/>
				</TooltipProvider>,
			);
		});

		const fileToggle = findFileToggle(container);
		expect(fileToggle).toBeInstanceOf(HTMLButtonElement);
		// Icon-only: no "File" text label anymore.
		expect(fileToggle?.textContent?.trim()).toBe("");
		expect(findButtonByText(container, "File")).toBeNull();

		// The toggle sits in the top-right actions cluster, before Settings.
		const settingsButton = container.querySelector<HTMLButtonElement>('[data-testid="open-settings-button"]');
		expect(settingsButton).toBeInstanceOf(HTMLButtonElement);
		const relativeToSettings = (fileToggle as HTMLButtonElement).compareDocumentPosition(
			settingsButton as HTMLButtonElement,
		);
		expect(relativeToSettings & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("hides the File toggle when no workspace is available", async () => {
		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					shortcuts={[]}
					fileSurfaceWorkspaceId={null}
					onOpenSettings={() => {}}
				/>,
			);
		});

		expect(findFileToggle(container)).toBeNull();
	});

	// The core of this change: in BOTH board (no selected task) and task/session
	// (a task selected) views, clicking File opens the anchored popover — never a
	// docked side panel.
	it.each([
		["board", null],
		["session", "task-1"],
	])("opens the File popover (not a dock) in %s mode", async (_mode, selectedTaskId) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						shortcuts={[]}
						selectedTaskId={selectedTaskId}
						selectedTaskBaseRef={selectedTaskId ? "main" : null}
						fileSurfaceWorkspaceId="ws-1"
						onOpenSettings={() => {}}
					/>
				</TooltipProvider>,
			);
		});

		const fileToggle = findFileToggle(container);
		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(false);

		await act(async () => {
			fileToggle?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			fileToggle?.click();
		});

		expect(fileSurfaceStore.getSnapshot().libraryOpen).toBe(true);
		// The popover content is portaled to <body> (a Radix popover), not rendered
		// as a docked `<aside>` sibling inside the top bar's own container.
		expect(document.body.querySelector('[aria-label="Close Files"]')).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector("aside")).toBeNull();
	});

	it("reflects the File surface active state on the File toggle", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TopBar
						openTargetOptions={[]}
						selectedOpenTargetId="vscode"
						onSelectOpenTarget={() => {}}
						onOpenWorkspace={() => {}}
						canOpenWorkspace={false}
						isOpeningWorkspace={false}
						shortcuts={[]}
						fileSurfaceWorkspaceId="ws-1"
						onOpenSettings={() => {}}
					/>
				</TooltipProvider>,
			);
		});

		const inactiveToggle = findFileToggle(container);
		expect(inactiveToggle?.className.split(/\s+/)).not.toContain("bg-surface-3");

		// Opening the File surface flips the shared store; the toggle picks up the
		// active highlight via `FilePopover`'s `useFileSurfaceActive` subscription.
		await act(async () => {
			fileSurfaceStore.openLibrary();
		});

		const activeToggle = findFileToggle(container);
		expect(activeToggle?.className.split(/\s+/)).toContain("bg-surface-3");
	});

	it("omits the owner indicator when the selected task has no owner", async () => {
		await act(async () => {
			root.render(
				<TopBar
					openTargetOptions={[]}
					selectedOpenTargetId="vscode"
					onSelectOpenTarget={() => {}}
					onOpenWorkspace={() => {}}
					canOpenWorkspace={false}
					isOpeningWorkspace={false}
					shortcuts={[]}
					selectedTaskId="task-1"
					selectedTaskBaseRef="main"
					selectedTaskOwner={null}
				/>,
			);
		});

		const ownerBadge = Array.from(container.querySelectorAll("span")).find((span) =>
			span.getAttribute("title")?.startsWith("Created by"),
		);
		expect(ownerBadge).toBeUndefined();
	});
});
