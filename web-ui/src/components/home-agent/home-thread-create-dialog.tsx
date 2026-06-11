import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

interface HomeThreadCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	onCreate: (input: { name: string; agentId: RuntimeAgentId }) => void | Promise<void>;
}

export function HomeThreadCreateDialog({
	open,
	onOpenChange,
	agents,
	defaultAgentId,
	onCreate,
}: HomeThreadCreateDialogProps): React.ReactElement {
	const [name, setName] = useState("");
	const [agentId, setAgentId] = useState<RuntimeAgentId>(defaultAgentId);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (open) {
			setName("");
			setAgentId(defaultAgentId);
			setIsSubmitting(false);
		}
	}, [open, defaultAgentId]);

	const trimmedName = name.trim();
	const canSubmit = trimmedName.length > 0 && !isSubmitting;

	const handleSubmit = async () => {
		if (!canSubmit) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onCreate({ name: trimmedName, agentId });
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-sm">
			<DialogHeader title="New chat thread" />
			<DialogBody className="flex flex-col gap-3">
				<label htmlFor="home-thread-name" className="flex flex-col gap-1 text-[13px] text-text-secondary">
					Name
					<input
						id="home-thread-name"
						type="text"
						value={name}
						autoFocus
						placeholder="e.g. Debugging"
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void handleSubmit();
							}
						}}
						className="h-8 rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
					/>
				</label>
				<label htmlFor="home-thread-agent" className="flex flex-col gap-1 text-[13px] text-text-secondary">
					Agent
					<NativeSelect
						id="home-thread-agent"
						fill
						value={agentId}
						onChange={(event) => setAgentId(event.target.value as RuntimeAgentId)}
					>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.label}
							</option>
						))}
					</NativeSelect>
				</label>
			</DialogBody>
			<DialogFooter>
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
