// Quick rename for a config profile — a focused alternative to opening the full
// edit dialog just to change a name. Mirrors HomeThreadRenameDialog.
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { AgentProfileActionResult } from "@/hooks/use-agent-profiles";
import type { RuntimeAgentProfile } from "@/runtime/types";

interface AgentProfileRenameDialogProps {
	/** null => closed. */
	profile: RuntimeAgentProfile | null;
	onOpenChange: (open: boolean) => void;
	onRename: (id: string, name: string) => Promise<AgentProfileActionResult>;
}

export function AgentProfileRenameDialog({
	profile,
	onOpenChange,
	onRename,
}: AgentProfileRenameDialogProps): React.ReactElement {
	const [name, setName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (profile) {
			setName(profile.name);
			setIsSubmitting(false);
		}
	}, [profile]);

	const trimmedName = name.trim();
	const canSubmit = trimmedName.length > 0 && !isSubmitting && trimmedName !== profile?.name;

	const handleSubmit = async (): Promise<void> => {
		if (!profile || !canSubmit) {
			return;
		}
		setIsSubmitting(true);
		try {
			const result = await onRename(profile.id, trimmedName);
			if (result.ok) {
				onOpenChange(false);
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={profile !== null} onOpenChange={onOpenChange} contentClassName="max-w-sm">
			<DialogHeader title="Rename profile" />
			<DialogBody>
				<input
					type="text"
					value={name}
					autoFocus
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void handleSubmit();
						}
					}}
					className="h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
				/>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					Rename
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
