import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyLocalTaskSessionSummary, resetRuntimeStreamStoreForTest } from "@/runtime/runtime-stream-store";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;
let mockMeasureWidths = [240, 240, 240];
let mockMeasureCallCount = 0;

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

const mockShowAppToast = vi.fn();

vi.mock("@/components/app-toaster", () => ({
	showAppToast: (...args: unknown[]) => mockShowAppToast(...args),
}));

const mockCopyToClipboard = vi.fn();

vi.mock("@/utils/react-use", () => ({
	useMedia: () => false,
	useCopyToClipboard: () => [{ value: undefined, error: undefined, noUserInteraction: true }, mockCopyToClipboard],
	useMeasure: () => {
		mockMeasureCallCount += 1;
		const width = mockMeasureWidths[(mockMeasureCallCount - 1) % mockMeasureWidths.length] ?? 240;
		return [
			() => {},
			{
				width,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
		];
	},
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
		normalizePromptForDisplay: (value: string) => value.split("||")[0]?.trim() ?? value.trim(),
		getTaskPromptDescription: (prompt: string, title: string) => {
			const normalized = prompt.trim();
			if (!normalized.startsWith(title)) {
				return normalized;
			}
			return normalized.slice(title.length).replace(/^\|\|/, "").trim();
		},
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "pi",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetRuntimeStreamStoreForTest();
		mockWorkspaceSnapshot = undefined;
		mockMeasureWidths = [240, 240, 240];
		mockMeasureCallCount = 0;
		mockCopyToClipboard.mockClear();
		mockShowAppToast.mockClear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			root.render(<Harness />);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("marks the card body for off-screen render culling", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="backlog" />);
		});

		// The culling opt-in must live on the inner body, not the draggable shell, so that
		// @hello-pangea/dnd still measures the card and the drag shadow isn't clipped.
		const shell = container.querySelector(".kb-board-card-shell");
		expect(shell).toBeInstanceOf(HTMLElement);
		expect(shell?.classList.contains("kb-board-card-body")).toBe(false);
		expect(container.querySelector(".kb-board-card-shell .kb-board-card-body")).toBeInstanceOf(HTMLElement);
	});

	it("copies the full task id and toasts when the id chip is clicked", async () => {
		const onActivate = vi.fn();
		await act(async () => {
			root.render(
				<BoardCard card={createCard({ id: "0a42e" })} index={0} columnId="backlog" onActivate={onActivate} />,
			);
		});

		const chip = container.querySelector('button[aria-label="Copy task ID 0a42e"]');
		expect(chip).toBeInstanceOf(HTMLButtonElement);
		expect(chip?.textContent?.trim()).toBe("0a42e");

		await act(async () => {
			chip?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			(chip as HTMLButtonElement | null)?.click();
		});

		expect(mockCopyToClipboard).toHaveBeenCalledWith("0a42e");
		expect(mockShowAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ intent: "success", message: "已复制任务 ID" }),
			"copy-task-id:0a42e",
		);
		// Copying the id must not select/open the card.
		expect(onActivate).not.toHaveBeenCalled();
	});

	it("renders the id chip on trash cards too", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard({ id: "0a42e" })} index={0} columnId="trash" />
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('button[aria-label="Copy task ID 0a42e"]')).toBeInstanceOf(HTMLButtonElement);
	});

	it("shows a loading state on the review done button while moving to done", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("labels the trash action as restore when no agent session id is recorded", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(createSummary("interrupted", { agentSessionId: null }));
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="trash" />
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('button[aria-label="Restore task from done"]')).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector('button[aria-label="Continue task session"]')).toBeNull();
	});

	it("offers continue session on a trash card that has a recorded agent session id", async () => {
		const onRestoreFromTrash = vi.fn();
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("interrupted", {
					agentId: "claude",
					agentSessionId: "550e8400-e29b-41d4-a716-446655440000",
				}),
			);
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="trash" onRestoreFromTrash={onRestoreFromTrash} />
				</TooltipProvider>,
			);
		});

		const continueButton = container.querySelector('button[aria-label="Continue task session"]');
		expect(continueButton).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector('button[aria-label="Restore task from done"]')).toBeNull();

		await act(async () => {
			continueButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			(continueButton as HTMLButtonElement | null)?.click();
		});
		expect(onRestoreFromTrash).toHaveBeenCalledWith("task-1");
	});

	it("shows inline see more and less controls for long descriptions", async () => {
		const description =
			"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau final hidden segment";

		await act(async () => {
			root.render(
				<BoardCard card={createCard({ prompt: `Task title||${description}` })} index={0} columnId="backlog" />,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		const seeMoreButton = findButton("See more");
		expect(seeMoreButton).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");

		await act(async () => {
			seeMoreButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			seeMoreButton?.click();
		});

		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeDefined();
		expect(container.textContent).toContain(description);

		const lessButton = findButton("Less");
		await act(async () => {
			lessButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lessButton?.click();
		});

		expect(findButton("See more")).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");
	});

	it("reconstructs and shows trashed worktree path when workspace metadata is not tracked", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("~/.kanban/worktrees/trash-task-1/kanban");
	});

	it("shows formatted agent override details with model name and reasoning effort", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			branch: "feature/override",
			isDetached: false,
			headCommit: "1234567890abcdef",
			changedFiles: 2,
			additions: 5,
			deletions: 1,
		};

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "pi",
						agentSettings: {
							modelId: "openai/gpt-5.5",
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="review"
				/>,
			);
		});

		expect(container.textContent).toContain("Kanban");
		expect(container.textContent).toContain("GPT-5.5 (Low)");
		expect(container.textContent).not.toContain("openai/gpt-5.5");
	});

	it("shows the task-level indicator for reasoning-only overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
					defaultKanbanModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Low)");
	});

	it("shows a fallback indicator for reasoning-only overrides without a resolved default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Default model (Low)");
	});

	it("shows explicit default reasoning metadata for reasoning-only task overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "pi",
						agentSettings: {},
					})}
					index={0}
					columnId="backlog"
					defaultKanbanModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Default)");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("does not mislabel provider-only overrides as the global default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentSettings: {
							providerId: "groq",
						},
					})}
					index={0}
					columnId="backlog"
					defaultKanbanModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("Provider: groq");
		expect(container.textContent).not.toContain("GPT-5.5");
	});

	it("does not show inherited global reasoning for explicit model overrides using default effort", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "pi",
						agentSettings: {
							modelId: "openai/gpt-5.5",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId: "pi",
				workspacePath: "/tmp/worktree",
				pid: null,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				lastOutputAt: Date.now(),
				reviewReason: null,
				exitCode: null,
				lastHookAt: Date.now(),
				latestHookActivity: {
					activityText: "Using Read",
					toolName: "Read",
					toolInputSummary: "src/index.ts",
					finalMessage: null,
					hookEventName: "tool_call",
					notificationType: null,
					source: "pi",
				},
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows non-cline tool activity in the compact tool label format", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					agentId: "claude",
					latestHookActivity: {
						activityText: "Completed Read: src/index.ts",
						toolName: "Read",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "tool_result",
						notificationType: null,
						source: "claude",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("keeps canonical tool names in the session preview label", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					agentId: "kiro",
					latestHookActivity: {
						activityText: "Using fs_write: src/index.ts",
						toolName: "fs_write",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "preToolUse",
						notificationType: null,
						source: "kiro",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("fs_write(src/index.ts)");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					agentId: "codex",
					latestHookActivity: {
						activityText: "Calling Read: src/index.ts",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "raw_response_item",
						notificationType: null,
						source: "codex",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("does not show a stale bare tool name for non-tool review updates", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("awaiting_review", {
					agentId: "kiro",
					latestHookActivity: {
						activityText: "Waiting for review",
						toolName: "fs_write",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "stop",
						notificationType: null,
						source: "kiro",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="review" />);
		});

		expect(container.textContent).toContain("Waiting for review");
		expect(container.textContent).not.toContain("fs_write");
	});

	it("keeps showing the last cline tool label during assistant streaming", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary({
				taskId: "task-1",
				state: "running",
				agentId: "pi",
				workspacePath: "/tmp/worktree",
				pid: null,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				lastOutputAt: Date.now(),
				reviewReason: null,
				exitCode: null,
				lastHookAt: Date.now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: "Read",
					toolInputSummary: "src/index.ts",
					finalMessage: "Looking at the file now",
					hookEventName: "assistant_delta",
					notificationType: null,
					source: "pi",
				},
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("renders a new card description before the async measure observer reports width", async () => {
		mockMeasureWidths = [0, 0, 0];

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ prompt: "Task title||Freshly created task description" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Freshly created task description");
	});

	it("renders session activity as single-line truncated text on trash cards", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("awaiting_review", {
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: preview,
						hookEventName: "assistant_delta",
						notificationType: null,
						source: "pi",
					},
				}),
			);
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="trash" />
				</TooltipProvider>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("renders session activity as single-line truncated text for running tasks", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: preview,
						hookEventName: "assistant_delta",
						notificationType: null,
						source: "pi",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					latestHookActivity: {
						activityText: "Reviewing the final diff",
						toolName: null,
						toolInputSummary: null,
						finalMessage: "Reviewing the final diff",
						hookEventName: "assistant_delta",
						notificationType: null,
						source: "pi",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			applyLocalTaskSessionSummary(
				createSummary("running", {
					agentId: "codex",
					latestHookActivity: {
						activityText: "Agent: checking the next file",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "agent_message",
						notificationType: null,
						source: "codex",
					},
				}),
			);
			root.render(<BoardCard card={createCard()} index={0} columnId="in_progress" />);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});
});
