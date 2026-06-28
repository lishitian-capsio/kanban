// Confirmation shown before a voice board command runs. Displays the concrete,
// already-resolved action ("移动任务 「登录 bug」→「完成」") so a misrecognized
// command can be cancelled before it reaches the agent.

import { Mic } from "lucide-react";
import type { ReactElement } from "react";
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

import type { PendingVoiceCommand } from "./use-voice-command-controller";

export function VoiceCommandConfirmDialog({
	pending,
	onConfirm,
	onCancel,
}: {
	pending: PendingVoiceCommand | null;
	onConfirm: () => void;
	onCancel: () => void;
}): ReactElement {
	const isDelete = pending?.resolved.kind === "delete";
	return (
		<AlertDialog
			open={pending !== null}
			onOpenChange={(open) => {
				if (!open) {
					onCancel();
				}
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle className="flex items-center gap-2">
					<Mic size={14} className="text-accent" />
					确认语音指令
				</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				{pending ? (
					<>
						<div className="rounded-md border border-border bg-surface-2 p-3">
							<div className="text-sm font-semibold text-text-primary">{pending.summary.title}</div>
							<AlertDialogDescription className="mt-1 text-text-secondary">
								{pending.summary.detail}
							</AlertDialogDescription>
						</div>
						<p className="m-0 text-xs text-text-tertiary">确认后将发送给 Kanban 助手执行。</p>
					</>
				) : null}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						取消
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant={isDelete ? "danger" : "primary"} onClick={onConfirm}>
						确认执行
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
