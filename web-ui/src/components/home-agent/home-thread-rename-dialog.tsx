import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

interface HomeThreadRenameDialogProps {
	thread: HomeThread | null;
	onOpenChange: (open: boolean) => void;
	onRename: (threadId: string, name: string) => void | Promise<void>;
}

export function HomeThreadRenameDialog({
	thread,
	onOpenChange,
	onRename,
}: HomeThreadRenameDialogProps): React.ReactElement {
	const [name, setName] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (thread) {
			setName(thread.name);
			setIsSubmitting(false);
		}
	}, [thread]);

	const trimmedName = name.trim();
	const canSubmit = trimmedName.length > 0 && !isSubmitting && trimmedName !== thread?.name;

	const handleSubmit = async () => {
		if (!thread || !canSubmit) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onRename(thread.id, trimmedName);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={thread !== null} onOpenChange={onOpenChange} contentClassName="max-w-sm">
			<DialogHeader title="Rename chat thread" />
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
