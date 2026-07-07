import { type ReactElement, useEffect, useState } from "react";

import type { ImChannelTarget } from "@/components/im/im-channel";
import { ImChannelChip } from "@/components/im/im-channel-chip";
import { ImChannelPicker } from "@/components/im/im-channel-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { HomeThread } from "@/hooks/use-home-threads";

interface ImChannelBindDialogProps {
	thread: HomeThread | null;
	/** Workspace scope for the bindable IM chat list shown in the picker. */
	workspaceId?: string | null;
	onOpenChange: (open: boolean) => void;
	onBind: (threadId: string, channel: ImChannelTarget) => void | Promise<void>;
	onUnbind: (threadId: string) => void | Promise<void>;
}

function sameChannel(a: ImChannelTarget | null, b: ImChannelTarget | null): boolean {
	if (!a || !b) return a === b;
	return a.platform === b.platform && a.chatId === b.chatId;
}

export function ImChannelBindDialog({
	thread,
	workspaceId = null,
	onOpenChange,
	onBind,
	onUnbind,
}: ImChannelBindDialogProps): ReactElement {
	const current = thread?.imChannel ?? null;
	const [draft, setDraft] = useState<ImChannelTarget | null>(current);
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (thread) {
			setDraft(thread.imChannel ?? null);
			setIsSubmitting(false);
		}
	}, [thread]);

	const changed = Boolean(draft) && !sameChannel(draft, current);

	const handleBind = async () => {
		if (!thread || !draft || !changed || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onBind(thread.id, draft);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleUnbind = async () => {
		if (!thread || !current || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onUnbind(thread.id);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={thread !== null} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="绑定 IM 频道" />
			<DialogBody className="flex flex-col gap-4">
				{current ? (
					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">已绑定</span>
						<div className="flex items-center gap-2">
							<ImChannelChip channel={current} />
							<Button variant="ghost" size="sm" disabled={isSubmitting} onClick={() => void handleUnbind()}>
								解绑
							</Button>
						</div>
					</div>
				) : null}
				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">
						{current ? "重新绑定" : "选择平台与频道"}
					</span>
					<ImChannelPicker value={draft} onChange={setDraft} workspaceId={workspaceId} disabled={isSubmitting} />
				</div>
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					取消
				</Button>
				<Button variant="primary" size="sm" disabled={!changed || isSubmitting} onClick={() => void handleBind()}>
					{current ? "更新绑定" : "绑定"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
