// The resident, always-visible "IM 会话列表" management surface for the Home dashboard
// (requirement ac99c, task B). Each row is one saved IM chat and shows, at a glance:
//   - the platform (飞书 / 钉钉) + the resolved group/conversation name (falls back to the id);
//   - its binding status — 未绑定, or 已绑定 → 会话『X』 with the bound thread's agent;
//   - the row actions: 绑定 / 切换 / 解绑 / 移除.
//
// The list reuses the same per-workspace palette as the picker (`useImChats`); binding status is
// derived by reverse-lookup — an IM chat is bound iff some thread's `imChannel` matches its
// (platform, chatId). One-to-one is intrinsic to that lookup (a chat maps to at most one thread),
// and switching a bound chat to another thread goes through the exclusive bind (see
// ImChatBindThreadDialog). Removing a chat only drops the palette entry; it never edits a binding.

import { MessageCircle, Plus, Radio, Trash2, Unlink } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

import { AgentIcon } from "@/components/home-agent/agent-icon";
import {
	IM_PLATFORM_LABELS,
	IM_PLATFORM_OPTIONS,
	type ImChannelTarget,
	type ImPlatform,
	imChannelDisplayLabel,
	inferLarkKindLabel,
} from "@/components/im/im-channel";
import { ImChatBindThreadDialog } from "@/components/im/im-chat-bind-thread-dialog";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { HomeThread } from "@/hooks/use-home-threads";
import { useImChats } from "@/hooks/use-im-chats";
import type { RuntimeAgentDefinition, RuntimeImChat } from "@/runtime/types";

interface ImChatListPanelProps {
	workspaceId: string | null;
	/** The full thread list — used to reverse-lookup each chat's binding and to offer bind targets. */
	threads: HomeThread[];
	agents: RuntimeAgentDefinition[];
	/** Bind (or exclusively switch) an IM channel to a thread — the one-to-one hook mutation. */
	onBindChannel: (threadId: string, channel: ImChannelTarget) => void | Promise<void>;
	/** Remove a thread's IM channel binding. */
	onUnbindChannel: (threadId: string) => void | Promise<void>;
}

/** Subtle per-platform tint for the leading chat glyph. */
const PLATFORM_TINT: Record<ImPlatform, string> = {
	lark: "text-status-blue",
	dingtalk: "text-status-purple",
};

function kindLabelFor(platform: ImPlatform, chatId: string): string {
	return platform === "lark" ? inferLarkKindLabel(chatId) : "群";
}

export function ImChatListPanel({
	workspaceId,
	threads,
	agents,
	onBindChannel,
	onUnbindChannel,
}: ImChatListPanelProps): ReactElement {
	const { chats, isLoading, error, addChat, removeChat } = useImChats(workspaceId);

	const [bindTargetChat, setBindTargetChat] = useState<RuntimeImChat | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [addPlatform, setAddPlatform] = useState<ImPlatform>("lark");
	const [addChatId, setAddChatId] = useState("");
	const [isAdding, setIsAdding] = useState(false);

	// The synthetic default thread can never hold a binding, so it is not a bind target.
	const bindableThreads = useMemo(() => threads.filter((thread) => !thread.isDefault), [threads]);

	// Reverse-lookup: chatKey → the thread bound to it (one-to-one, so at most one).
	const boundThreadByChatKey = useMemo(() => {
		const map = new Map<string, HomeThread>();
		for (const thread of threads) {
			if (thread.imChannel) {
				map.set(`${thread.imChannel.platform}:${thread.imChannel.chatId}`, thread);
			}
		}
		return map;
	}, [threads]);

	const trimmedAddChatId = addChatId.trim();
	const handleAdd = async () => {
		if (!trimmedAddChatId || isAdding) {
			return;
		}
		setIsAdding(true);
		try {
			const added = await addChat({ platform: addPlatform, chatId: trimmedAddChatId });
			if (added) {
				setAddChatId("");
				setAddOpen(false);
			}
		} finally {
			setIsAdding(false);
		}
	};

	const bindTargetCurrentThreadId = bindTargetChat
		? (boundThreadByChatKey.get(`${bindTargetChat.platform}:${bindTargetChat.chatId}`)?.id ?? null)
		: null;

	const handleBindConfirm = (threadId: string) => {
		if (!bindTargetChat) {
			return;
		}
		return onBindChannel(threadId, { platform: bindTargetChat.platform, chatId: bindTargetChat.chatId });
	};

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between px-1">
				<div className="flex items-baseline gap-2">
					<h2 className="text-sm font-semibold text-text-primary">IM 会话</h2>
					{chats.length > 0 ? <span className="text-[12px] text-text-tertiary">{chats.length}</span> : null}
				</div>
				<button
					type="button"
					onClick={() => setAddOpen((open) => !open)}
					className="flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-1 text-[12px] text-text-tertiary outline-none hover:bg-surface-3 hover:text-text-secondary"
				>
					<Plus size={12} />
					添加会话 ID
				</button>
			</div>

			{addOpen ? (
				<div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-2/50 p-2">
					<div className="flex items-center gap-2">
						<div className="flex shrink-0 overflow-hidden rounded-md border border-border-bright">
							{IM_PLATFORM_OPTIONS.map((option) => (
								<button
									key={option.value}
									type="button"
									disabled={isAdding}
									onClick={() => setAddPlatform(option.value)}
									className={cn(
										"cursor-pointer px-2.5 py-1.5 text-[12px] outline-none disabled:opacity-50",
										addPlatform === option.value
											? "bg-surface-3 text-text-primary"
											: "bg-surface-2 text-text-secondary hover:bg-surface-3",
									)}
								>
									{option.label}
								</button>
							))}
						</div>
						<input
							type="text"
							aria-label="IM chat ID"
							value={addChatId}
							disabled={isAdding}
							onChange={(event) => setAddChatId(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void handleAdd();
								}
							}}
							placeholder="粘贴群 / 单聊 ID,如 oc_…"
							className="h-8 min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus disabled:opacity-50"
						/>
						<button
							type="button"
							onClick={() => void handleAdd()}
							disabled={isAdding || !trimmedAddChatId}
							className="flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
						>
							添加
						</button>
					</div>
					<p className="text-[11px] text-text-tertiary">
						添加后会保存到会话列表,可再绑定到某个会话。入站 @机器人 的会话会自动出现在这里。
					</p>
				</div>
			) : null}

			{error ? <p className="px-1 text-[12px] text-status-red">{error}</p> : null}

			{isLoading && chats.length === 0 ? (
				<div className="flex items-center justify-center rounded-md border border-border bg-surface-2 px-3 py-6">
					<Spinner size={18} />
				</div>
			) : chats.length === 0 ? (
				<p className="rounded-md border border-dashed border-border bg-surface-2/50 px-3 py-4 text-[12px] text-text-tertiary">
					还没有已保存的 IM 会话。入站 @机器人 的会话会自动出现在这里,也可手动添加会话 ID。
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{chats.map((chat) => {
						const key = `${chat.platform}:${chat.chatId}`;
						const boundThread = boundThreadByChatKey.get(key) ?? null;
						const primary = imChannelDisplayLabel(chat.chatId, chat.displayName);
						return (
							<li
								key={key}
								className="flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-2.5 py-2"
							>
								<MessageCircle size={16} className={cn("shrink-0", PLATFORM_TINT[chat.platform])} />
								<div className="flex min-w-0 flex-1 flex-col">
									<span
										className={cn(
											"truncate text-[13px] text-text-primary",
											!chat.displayName.trim() && "font-mono text-text-secondary",
										)}
										title={chat.chatId}
									>
										{primary}
									</span>
									<span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
										<span>
											{IM_PLATFORM_LABELS[chat.platform]} · {kindLabelFor(chat.platform, chat.chatId)}
										</span>
										{chat.source === "inbound" ? <span>· 自动发现</span> : null}
									</span>
								</div>

								<div className="flex min-w-0 shrink-0 items-center gap-1.5">
									{boundThread ? (
										<span className="flex min-w-0 items-center gap-1 rounded-sm bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary">
											<AgentIcon agents={agents} agentId={boundThread.agentId} size={12} />
											<span className="max-w-[120px] truncate">已绑定 → {boundThread.name}</span>
										</span>
									) : (
										<span className="text-[11px] text-text-tertiary">未绑定</span>
									)}
								</div>

								<div className="flex shrink-0 items-center gap-0.5">
									<button
										type="button"
										aria-label={boundThread ? "切换绑定的会话" : "绑定到会话"}
										title={boundThread ? "切换到其他会话" : "绑定到会话"}
										onClick={() => setBindTargetChat(chat)}
										className={cn(
											"cursor-pointer rounded-sm p-1.5 hover:bg-surface-3 hover:text-text-primary",
											boundThread ? "text-accent" : "text-text-tertiary",
										)}
									>
										<Radio size={14} />
									</button>
									{boundThread ? (
										<button
											type="button"
											aria-label="解绑"
											title="解绑"
											onClick={() => void onUnbindChannel(boundThread.id)}
											className="cursor-pointer rounded-sm p-1.5 text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
										>
											<Unlink size={14} />
										</button>
									) : null}
									<button
										type="button"
										aria-label="移除"
										title="从列表移除"
										onClick={() => void removeChat(chat.platform, chat.chatId)}
										className="cursor-pointer rounded-sm p-1.5 text-text-tertiary hover:bg-surface-3 hover:text-status-red"
									>
										<Trash2 size={14} />
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<ImChatBindThreadDialog
				chat={bindTargetChat}
				threads={bindableThreads}
				agents={agents}
				currentBoundThreadId={bindTargetCurrentThreadId}
				onOpenChange={(open) => {
					if (!open) {
						setBindTargetChat(null);
					}
				}}
				onConfirm={handleBindConfirm}
			/>
		</section>
	);
}
