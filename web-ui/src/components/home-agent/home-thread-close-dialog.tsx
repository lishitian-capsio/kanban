import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

interface HomeThreadCloseDialogProps {
	thread: HomeThread | null;
	onOpenChange: (open: boolean) => void;
	onClose: (threadId: string) => void | Promise<void>;
}

export function HomeThreadCloseDialog({
	thread,
	onOpenChange,
	onClose,
}: HomeThreadCloseDialogProps): React.ReactElement {
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleClose = async () => {
		if (!thread) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onClose(thread.id);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<AlertDialog open={thread !== null} onOpenChange={onOpenChange}>
			<AlertDialogHeader>
				<AlertDialogTitle>Close chat thread</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription asChild>
					<div className="flex flex-col gap-3">
						<p className="text-text-primary">{thread ? thread.name : "This thread"}</p>
						<p>Closing stops the thread's agent session and permanently deletes its transcript.</p>
						<p>This action cannot be undone.</p>
					</div>
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="ghost" size="sm" disabled={isSubmitting}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button
						variant="danger"
						size="sm"
						disabled={isSubmitting}
						onClick={(event) => {
							event.preventDefault();
							void handleClose();
						}}
					>
						Close thread
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
