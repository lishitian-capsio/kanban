// Picks WHICH home thread (会话) a saved IM chat binds to — the inverse of ImChannelPicker
// (which picks an IM chat for a thread). Driven by the resident IM-chat management list
// (requirement ac99c, task B).
//
// One-to-one binding is enforced from the thread→channel direction: binding this chat to a
// target thread routes through `bindThreadImChannel`, whose exclusive backend + the hook's
// `clearImChannelFromOtherThreads` mirror auto-unbind the chat from any prior thread. So when
// the chat is already bound elsewhere, selecting a *different* thread is a SWITCH, not a second
// bind: the primary action reads "切换到此会话" and a warning surfaces which thread it detaches
// from — the "避免误抢正在使用的 IM 会话" confirmation the spec asks for.

import { type ReactElement, useEffect, useMemo, useState } from "react";

import { AgentIcon, resolveAgentLabel } from "@/components/home-agent/agent-icon";
import { describeImChannel, imChannelDisplayLabel } from "@/components/im/im-channel";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeImChat } from "@/runtime/types";

interface ImChatBindThreadDialogProps {
	/** The chat being bound. `null` closes the dialog. */
	chat: RuntimeImChat | null;
	/** Bindable target threads (the synthetic default thread cannot bind, so it is excluded upstream). */
	threads: HomeThread[];
	agents: RuntimeAgentDefinition[];
	/** The thread this chat is currently bound to (if any) — drives the switch-vs-bind wording. */
	currentBoundThreadId: string | null;
	onOpenChange: (open: boolean) => void;
	/** Bind (or switch) this chat to `threadId`. Exclusive one-to-one is handled by the caller's hook. */
	onConfirm: (threadId: string) => void | Promise<void>;
}

export function ImChatBindThreadDialog({
	chat,
	threads,
	agents,
	currentBoundThreadId,
	onOpenChange,
	onConfirm,
}: ImChatBindThreadDialogProps): ReactElement {
	const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset the draft each time a chat opens the dialog.
	useEffect(() => {
		if (chat) {
			setSelectedThreadId(null);
			setIsSubmitting(false);
		}
	}, [chat]);

	const chatPrimary = chat ? imChannelDisplayLabel(chat.chatId, chat.displayName) : "";
	const chatMeta = chat ? describeImChannel(chat) : null;

	const currentThread = useMemo(
		() => (currentBoundThreadId ? (threads.find((thread) => thread.id === currentBoundThreadId) ?? null) : null),
		[threads, currentBoundThreadId],
	);

	// A switch = the chat is already bound and the user picked a DIFFERENT thread.
	const isSwitch =
		Boolean(currentBoundThreadId) && selectedThreadId !== null && selectedThreadId !== currentBoundThreadId;
	// Nothing to do if no selection, or the selection is the thread it is already bound to.
	const canConfirm = selectedThreadId !== null && selectedThreadId !== currentBoundThreadId && !isSubmitting;

	const handleConfirm = async () => {
		if (!selectedThreadId || !canConfirm) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onConfirm(selectedThreadId);
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={chat !== null} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="绑定到会话" />
			<DialogBody className="flex flex-col gap-4">
				{chat ? (
					<div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 px-3 py-2">
						<span className="text-[13px] text-text-primary" title={chat.chatId}>
							{chatPrimary}
						</span>
						{chatMeta ? (
							<span className="text-[11px] text-text-tertiary">
								{chatMeta.platformLabel} · {chatMeta.kindLabel}
							</span>
						) : null}
					</div>
				) : null}

				{currentThread ? (
					<p className="text-[12px] text-text-secondary">
						当前已绑定 → 会话『<span className="text-text-primary">{currentThread.name}</span>』
					</p>
				) : null}

				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-text-secondary">选择会话</span>
					{threads.length === 0 ? (
						<p className="rounded-md border border-dashed border-border bg-surface-2/50 px-3 py-3 text-[12px] text-text-tertiary">
							还没有可绑定的会话,请先在 Sessions 中创建一个会话。
						</p>
					) : (
						<div className="scrollbar-overlay flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
							{threads.map((thread) => {
								const selected = thread.id === selectedThreadId;
								const isCurrent = thread.id === currentBoundThreadId;
								return (
									<button
										key={thread.id}
										type="button"
										disabled={isSubmitting}
										onClick={() => setSelectedThreadId(thread.id)}
										className={cn(
											"flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] outline-none disabled:opacity-50",
											selected
												? "border-border-focus bg-surface-3 text-text-primary"
												: "border-border-bright bg-surface-2 text-text-secondary hover:bg-surface-3",
										)}
									>
										<AgentIcon agents={agents} agentId={thread.agentId} size={14} />
										<span className="min-w-0 flex-1 truncate">{thread.name}</span>
										<span className="shrink-0 text-[11px] text-text-tertiary">
											{resolveAgentLabel(agents, thread.agentId)}
										</span>
										{isCurrent ? (
											<span className="shrink-0 rounded-sm bg-surface-4 px-1.5 py-0.5 text-[10px] text-text-secondary">
												当前
											</span>
										) : null}
									</button>
								);
							})}
						</div>
					)}
				</div>

				{isSwitch && currentThread ? (
					<p className="rounded-md border border-status-orange/40 bg-status-orange/10 px-3 py-2 text-[12px] text-status-orange">
						将从会话『{currentThread.name}』解绑,并绑定到新会话。一个 IM 会话至多绑定一个会话。
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					取消
				</Button>
				<Button variant="primary" size="sm" disabled={!canConfirm} onClick={() => void handleConfirm()}>
					{isSwitch ? "切换到此会话" : "绑定到此会话"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
