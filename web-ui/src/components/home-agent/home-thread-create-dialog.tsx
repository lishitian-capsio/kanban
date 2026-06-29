import { Check, MessageSquarePlus } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { AgentIcon } from "@/components/home-agent/agent-icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

interface HomeThreadCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	onCreate: (input: { description: string; agentId: RuntimeAgentId }) => void | Promise<unknown>;
}

export function HomeThreadCreateDialog({
	open,
	onOpenChange,
	agents,
	defaultAgentId,
	onCreate,
}: HomeThreadCreateDialogProps): React.ReactElement {
	// The native/main agent (pi) is always running and singular, so threads can
	// only be created for the additional CLI agents.
	const selectableAgents = useMemo(() => agents.filter((agent) => !isNativeAgentSelected(agent.id)), [agents]);

	// Fall back to the first selectable agent when the incoming default is the
	// native agent (or otherwise not selectable), so the form never opens with a
	// hidden or empty selection.
	const resolvedDefaultAgentId = useMemo<RuntimeAgentId | null>(() => {
		if (selectableAgents.some((agent) => agent.id === defaultAgentId)) {
			return defaultAgentId;
		}
		return selectableAgents[0]?.id ?? null;
	}, [selectableAgents, defaultAgentId]);

	const descriptionId = useId();
	const [description, setDescription] = useState("");
	const [agentId, setAgentId] = useState<RuntimeAgentId | null>(resolvedDefaultAgentId);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (open) {
			setDescription("");
			setAgentId(resolvedDefaultAgentId);
			setIsSubmitting(false);
		}
	}, [open, resolvedDefaultAgentId]);

	const trimmedDescription = description.trim();
	const canSubmit = trimmedDescription.length > 0 && !isSubmitting && agentId !== null;

	const handleSubmit = async () => {
		if (!canSubmit || agentId === null) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onCreate({ description: trimmedDescription, agentId });
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="New chat thread" icon={<MessageSquarePlus size={16} />} />
			<DialogBody className="flex flex-col gap-5">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={descriptionId} className="text-[12px] font-medium text-text-secondary">
						Description
					</label>
					<textarea
						id={descriptionId}
						value={description}
						autoFocus
						rows={4}
						placeholder="Describe what you want to work on…"
						onChange={(event) => setDescription(event.target.value)}
						onKeyDown={(event) => {
							// Enter inserts a newline; ⌘/Ctrl+Enter submits.
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void handleSubmit();
							}
						}}
						className="resize-none rounded-md border border-border bg-surface-2 px-2.5 py-2 text-[13px] leading-relaxed text-text-primary placeholder:text-text-tertiary transition-colors focus:border-border-focus focus:outline-none"
					/>
					<p className="text-[11px] text-text-tertiary">
						The thread's agent works on this and names the thread itself.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<span className="text-[12px] font-medium text-text-secondary">Agent</span>
					{selectableAgents.length === 0 ? (
						<p className="rounded-md border border-dashed border-border bg-surface-2 px-2.5 py-2 text-[12px] text-text-tertiary">
							No additional agents are available.
						</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{selectableAgents.map((agent) => {
								const selected = agent.id === agentId;
								return (
									<button
										key={agent.id}
										type="button"
										aria-pressed={selected}
										onClick={() => setAgentId(agent.id)}
										className={cn(
											"inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
											selected
												? "border-accent bg-accent/10 text-text-primary"
												: "border-border bg-surface-2 text-text-secondary hover:border-border-bright hover:bg-surface-3 hover:text-text-primary",
										)}
									>
										<AgentIcon agents={agents} agentId={agent.id} size={14} />
										{agent.label}
										{selected ? <Check size={13} className="text-accent" /> : null}
									</button>
								);
							})}
						</div>
					)}
				</div>
			</DialogBody>
			<DialogFooter>
				<span className="mr-auto hidden items-center gap-1 text-[11px] text-text-tertiary sm:flex">
					<Kbd>{isMacPlatform ? "⌘" : "Ctrl"}</Kbd>
					<Kbd>↵</Kbd>
					to create
				</span>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
