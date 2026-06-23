// Split-button "Ask" control for review cards. The primary button sends the
// task agent's review question to the currently-selected destination; the
// attached chevron opens a dropdown to choose the destination first.
//
// Destinations (who answers the question):
//   - "self"   → the task's own agent: let it decide and continue.
//   - "kanban" → the coordinating kanban agent, with task context.
//
// Sending never moves the task out of review — that is the orchestration hook's
// contract; this component only dispatches the chosen route.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bot, Check, ChevronDown, MessageCircleQuestion, User } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { AskTarget } from "@/git-actions/build-ask-prompt";

interface AskTargetMeta {
	id: AskTarget;
	/** Compact label shown on the primary button. */
	buttonLabel: string;
	/** Full label shown in the dropdown. */
	menuLabel: string;
	description: string;
	Icon: typeof User;
}

const ASK_TARGETS: readonly AskTargetMeta[] = [
	{
		id: "self",
		buttonLabel: "Ask agent",
		menuLabel: "Ask the task agent",
		description: "Send the question back so the agent makes its own call and continues.",
		Icon: User,
	},
	{
		id: "kanban",
		buttonLabel: "Ask kanban",
		menuLabel: "Ask the kanban agent",
		description: "Hand the question and task context to the coordinating kanban agent.",
		Icon: Bot,
	},
];

interface BoardCardAskControlProps {
	/** The review question being routed (used for the tooltip). */
	question: string | null;
	onAskSelf: () => void;
	onAskKanbanAgent: () => void;
	isLoading?: boolean;
	disabled?: boolean;
}

function stopEvent(event: MouseEvent<HTMLElement>): void {
	event.preventDefault();
	event.stopPropagation();
}

export function BoardCardAskControl({
	question,
	onAskSelf,
	onAskKanbanAgent,
	isLoading = false,
	disabled = false,
}: BoardCardAskControlProps): React.ReactElement {
	const [target, setTarget] = useState<AskTarget>("self");
	const [menuOpen, setMenuOpen] = useState(false);
	const activeMeta = ASK_TARGETS.find((meta) => meta.id === target) ?? ASK_TARGETS[0]!;

	const send = (event: MouseEvent<HTMLElement>) => {
		stopEvent(event);
		if (target === "kanban") {
			onAskKanbanAgent();
		} else {
			onAskSelf();
		}
	};

	const tooltipContent = question
		? `${activeMeta.description}\n\n“${question}”`
		: `${activeMeta.description}\n\nNo specific question was raised at review.`;

	return (
		<div className="flex min-w-0" style={{ flex: "1 1 0" }}>
			<Tooltip content={tooltipContent}>
				<Button
					variant="primary"
					size="sm"
					icon={isLoading ? <Spinner size={12} /> : <MessageCircleQuestion size={14} />}
					disabled={disabled || isLoading}
					className="min-w-0 flex-1 rounded-r-none"
					onMouseDown={stopEvent}
					onClick={send}
				>
					<span className="truncate">{activeMeta.buttonLabel}</span>
				</Button>
			</Tooltip>
			<DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenu.Trigger asChild>
					<Button
						variant="primary"
						size="sm"
						icon={<ChevronDown size={14} />}
						disabled={disabled || isLoading}
						aria-label="Choose where to send the question"
						className="rounded-l-none border-l border-accent-fg/30 px-1"
						onMouseDown={(event) => event.stopPropagation()}
						onClick={(event) => event.stopPropagation()}
					/>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						side="bottom"
						align="end"
						sideOffset={4}
						className="z-50 min-w-[240px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						{ASK_TARGETS.map((meta) => {
							const isActive = meta.id === target;
							const { Icon } = meta;
							return (
								<DropdownMenu.Item
									key={meta.id}
									className={cn(
										"flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-surface-3",
										isActive ? "text-text-primary" : "text-text-secondary",
									)}
									onSelect={() => setTarget(meta.id)}
								>
									<Check size={14} className={cn("mt-0.5 shrink-0", isActive ? "text-accent" : "opacity-0")} />
									<Icon size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="font-medium text-text-primary">{meta.menuLabel}</span>
										<span className="text-text-tertiary">{meta.description}</span>
									</span>
								</DropdownMenu.Item>
							);
						})}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}
