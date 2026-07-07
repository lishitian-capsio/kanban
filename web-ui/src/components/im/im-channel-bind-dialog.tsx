import { type ReactElement, useEffect, useMemo, useState } from "react";

import type { ImChannelTarget } from "@/components/im/im-channel";
import { ImChannelChip } from "@/components/im/im-channel-chip";
import { ImChannelPicker } from "@/components/im/im-channel-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useImChats } from "@/hooks/use-im-chats";

interface ImChannelBindDialogProps {
	/** Whether the dialog is shown. */
	open: boolean;
	/** The current binding, or `null` when unbound. */
	current: ImChannelTarget | null;
	/** Dialog title. Defaults to the generic bind title. */
	title?: string;
	/** Workspace scope for the bindable IM chat list shown in the picker. */
	workspaceId?: string | null;
	onOpenChange: (open: boolean) => void;
	onBind: (channel: ImChannelTarget) => void | Promise<void>;
	onUnbind: () => void | Promise<void>;
}

function sameChannel(a: ImChannelTarget | null, b: ImChannelTarget | null): boolean {
	if (!a || !b) return a === b;
	return a.platform === b.platform && a.chatId === b.chatId;
}

/**
 * Generic "bind this thing to an IM channel" dialog (requirement ac99c). The caller owns what is
 * being bound (a home thread or the single Pi conversation) and supplies the current binding plus
 * bind/unbind handlers — this component is only the picker + current-binding chip + submit states.
 */
export function ImChannelBindDialog({
	open,
	current,
	title = "绑定 IM 频道",
	workspaceId = null,
	onOpenChange,
	onBind,
	onUnbind,
}: ImChannelBindDialogProps): ReactElement {
	const [draft, setDraft] = useState<ImChannelTarget | null>(current);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Resolve the bound channel's human-readable name from the workspace palette so the "已绑定"
	// chip shows the group/conversation name rather than the opaque id.
	const { chats } = useImChats(workspaceId);
	const currentDisplayName = useMemo(() => {
		if (!current) return null;
		return (
			chats.find((chat) => chat.platform === current.platform && chat.chatId === current.chatId)?.displayName ?? null
		);
	}, [chats, current]);

	// Reset the draft to the current binding whenever the dialog (re)opens.
	useEffect(() => {
		if (open) {
			setDraft(current);
			setIsSubmitting(false);
		}
	}, [open, current]);

	const changed = Boolean(draft) && !sameChannel(draft, current);

	const handleBind = async () => {
		if (!draft || !changed || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onBind(draft);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleUnbind = async () => {
		if (!current || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onUnbind();
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title={title} />
			<DialogBody className="flex flex-col gap-4">
				{current ? (
					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">已绑定</span>
						<div className="flex items-center gap-2">
							<ImChannelChip channel={current} displayName={currentDisplayName} />
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
