import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, Plus } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";

import {
	IM_PLATFORM_LABELS,
	IM_PLATFORM_OPTIONS,
	type ImChannelTarget,
	type ImPlatform,
	inferLarkKindLabel,
} from "@/components/im/im-channel";
import { useImChats } from "@/hooks/use-im-chats";
import type { RuntimeImChat } from "@/runtime/types";

interface ImChannelPickerProps {
	value: ImChannelTarget | null;
	onChange: (value: ImChannelTarget | null) => void;
	/** Workspace scope for the bindable IM chat list. Without it the palette stays empty. */
	workspaceId?: string | null;
	disabled?: boolean;
}

// Sentinel for the "no binding" option — Radix Select needs a non-empty item value.
const NONE_VALUE = "__none__";

function chatKey(platform: ImPlatform, chatId: string): string {
	return `${platform}:${chatId}`;
}

/** The chat-kind sublabel: Lark infers group/single from the id prefix; DingTalk has no kind. */
function kindLabelFor(platform: ImPlatform, chatId: string): string {
	return platform === "lark" ? inferLarkKindLabel(chatId) : "群";
}

/**
 * Bind picker for the "IM 会话 id 列表" (requirement ac99c, 159ab). The primary control is a
 * dropdown over the workspace's saved IM chats — selecting one emits its `{platform, chatId}`
 * target. A compact "手动添加" fallback upserts a new id into the list (so it becomes reusable)
 * and selects it, which is also the way to seed an empty palette. This is binding/pointing
 * management only — the real conversation stays in the IM app.
 */
export function ImChannelPicker({ value, onChange, workspaceId = null, disabled }: ImChannelPickerProps): ReactElement {
	const { chats, isLoading, addChat } = useImChats(workspaceId);

	const [manualOpen, setManualOpen] = useState(false);
	const [manualPlatform, setManualPlatform] = useState<ImPlatform>("lark");
	const [manualChatId, setManualChatId] = useState("");
	const [isAdding, setIsAdding] = useState(false);

	// When the current value is not (yet) in the fetched palette — e.g. a thread bound before
	// the list existed — surface it as a synthetic option so the trigger can display it.
	const options = useMemo<RuntimeImChat[]>(() => {
		if (!value) {
			return chats;
		}
		const present = chats.some((chat) => chat.platform === value.platform && chat.chatId === value.chatId);
		if (present) {
			return chats;
		}
		const synthetic: RuntimeImChat = {
			platform: value.platform,
			chatId: value.chatId,
			displayName: "",
			source: "manual",
			createdAt: 0,
			updatedAt: 0,
		};
		return [synthetic, ...chats];
	}, [chats, value]);

	const selectedKey = value ? chatKey(value.platform, value.chatId) : NONE_VALUE;

	const handleSelect = (key: string) => {
		if (key === NONE_VALUE) {
			onChange(null);
			return;
		}
		const chat = options.find((entry) => chatKey(entry.platform, entry.chatId) === key);
		onChange(chat ? { platform: chat.platform, chatId: chat.chatId } : null);
	};

	const trimmedManualChatId = manualChatId.trim();
	const manualKindHint =
		manualPlatform === "lark" && trimmedManualChatId ? inferLarkKindLabel(trimmedManualChatId) : null;

	const handleAdd = async () => {
		if (!trimmedManualChatId || isAdding) {
			return;
		}
		setIsAdding(true);
		try {
			const added = await addChat({ platform: manualPlatform, chatId: trimmedManualChatId });
			if (added) {
				onChange({ platform: added.platform, chatId: added.chatId });
				setManualChatId("");
				setManualOpen(false);
			}
		} finally {
			setIsAdding(false);
		}
	};

	const selectDisabled = disabled || (options.length === 0 && !isLoading);

	return (
		<div className="flex flex-col gap-2">
			<RadixSelect.Root value={selectedKey} onValueChange={handleSelect} disabled={selectDisabled}>
				<RadixSelect.Trigger
					aria-label="IM 会话"
					className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 focus:border-border-focus disabled:opacity-50"
				>
					<RadixSelect.Value
						placeholder={
							isLoading
								? "加载 IM 会话列表…"
								: options.length === 0
									? "暂无已保存的 IM 会话"
									: "从 IM 会话列表选择…"
						}
					/>
					<RadixSelect.Icon>
						<ChevronDown size={14} className="shrink-0 text-text-tertiary" />
					</RadixSelect.Icon>
				</RadixSelect.Trigger>
				<RadixSelect.Portal>
					<RadixSelect.Content
						className="z-50 max-h-[40vh] overflow-hidden rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
						position="popper"
						sideOffset={4}
						align="start"
					>
						<RadixSelect.Viewport className="max-h-[40vh] overflow-y-auto">
							<RadixSelect.Item
								value={NONE_VALUE}
								className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-tertiary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
							>
								<RadixSelect.ItemText>不绑定</RadixSelect.ItemText>
								<RadixSelect.ItemIndicator className="ml-auto">
									<Check size={14} className="text-accent" />
								</RadixSelect.ItemIndicator>
							</RadixSelect.Item>
							{options.map((chat) => {
								const key = chatKey(chat.platform, chat.chatId);
								const primary = chat.displayName || chat.chatId;
								const meta = `${IM_PLATFORM_LABELS[chat.platform]} · ${kindLabelFor(chat.platform, chat.chatId)}`;
								return (
									<RadixSelect.Item
										key={key}
										value={key}
										className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
									>
										<RadixSelect.ItemText>
											<span className="flex min-w-0 flex-col">
												<span className="truncate">{primary}</span>
												<span className="truncate text-[11px] text-text-tertiary">
													{meta}
													{chat.source === "inbound" ? " · 自动发现" : ""}
												</span>
											</span>
										</RadixSelect.ItemText>
										<RadixSelect.ItemIndicator className="ml-auto shrink-0">
											<Check size={14} className="text-accent" />
										</RadixSelect.ItemIndicator>
									</RadixSelect.Item>
								);
							})}
						</RadixSelect.Viewport>
					</RadixSelect.Content>
				</RadixSelect.Portal>
			</RadixSelect.Root>

			{manualOpen ? (
				<div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-surface-2/50 p-2">
					<div className="flex items-center gap-2">
						<RadixSelect.Root
							value={manualPlatform}
							onValueChange={(next) => setManualPlatform(next as ImPlatform)}
							disabled={disabled || isAdding}
						>
							<RadixSelect.Trigger
								aria-label="IM platform"
								className="flex h-8 w-24 shrink-0 items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 focus:border-border-focus disabled:opacity-50"
							>
								<RadixSelect.Value />
								<RadixSelect.Icon>
									<ChevronDown size={14} className="text-text-tertiary" />
								</RadixSelect.Icon>
							</RadixSelect.Trigger>
							<RadixSelect.Portal>
								<RadixSelect.Content
									className="z-50 overflow-hidden rounded-lg border border-border bg-surface-1 p-1 shadow-xl"
									position="popper"
									sideOffset={4}
									align="start"
								>
									<RadixSelect.Viewport>
										{IM_PLATFORM_OPTIONS.map((option) => (
											<RadixSelect.Item
												key={option.value}
												value={option.value}
												className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary outline-none data-highlighted:bg-surface-3 data-highlighted:text-text-primary data-[state=checked]:text-text-primary"
											>
												<RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
												<RadixSelect.ItemIndicator className="ml-auto">
													<Check size={14} className="text-accent" />
												</RadixSelect.ItemIndicator>
											</RadixSelect.Item>
										))}
									</RadixSelect.Viewport>
								</RadixSelect.Content>
							</RadixSelect.Portal>
						</RadixSelect.Root>

						<input
							type="text"
							aria-label="IM chat ID"
							value={manualChatId}
							disabled={disabled || isAdding}
							onChange={(event) => setManualChatId(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void handleAdd();
								}
							}}
							placeholder="粘贴群 / 单聊 ID，如 oc_…"
							className="h-8 min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus disabled:opacity-50"
						/>
						<button
							type="button"
							onClick={() => void handleAdd()}
							disabled={disabled || isAdding || !trimmedManualChatId}
							className="flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
						>
							添加
						</button>
					</div>
					<p className="text-[11px] text-text-tertiary">
						{manualKindHint ? (
							<>
								识别为:<span className="text-text-secondary">{manualKindHint}</span>,添加后自动选中。
							</>
						) : (
							"飞书群设置 → 更多 → 复制群 ID。添加后会保存到会话列表并选中。"
						)}
					</p>
				</div>
			) : (
				<button
					type="button"
					onClick={() => setManualOpen(true)}
					disabled={disabled}
					className="flex w-fit cursor-pointer items-center gap-1 text-[12px] text-text-tertiary outline-none hover:text-text-secondary disabled:opacity-50"
				>
					<Plus size={12} />
					手动添加会话 ID
				</button>
			)}
		</div>
	);
}
