import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import {
	IM_PLATFORM_OPTIONS,
	type ImChannelTarget,
	type ImPlatform,
	inferLarkKindLabel,
} from "@/components/im/im-channel";

interface ImChannelPickerProps {
	value: ImChannelTarget | null;
	onChange: (value: ImChannelTarget | null) => void;
	disabled?: boolean;
}

export function ImChannelPicker({ value, onChange, disabled }: ImChannelPickerProps): ReactElement {
	// Platform is held locally so a selection survives an empty chatId (when the emitted
	// value is null). Re-seed only when the controlled value's primitives actually change —
	// keying the effect on primitives (not the object) means typing never resets local state.
	const [platform, setPlatform] = useState<ImPlatform>(value?.platform ?? "lark");
	const [chatId, setChatId] = useState<string>(value?.chatId ?? "");

	useEffect(() => {
		setPlatform(value?.platform ?? "lark");
		setChatId(value?.chatId ?? "");
	}, [value?.platform, value?.chatId]);

	const emit = (nextPlatform: ImPlatform, nextChatId: string) => {
		const trimmed = nextChatId.trim();
		onChange(trimmed ? { platform: nextPlatform, chatId: trimmed } : null);
	};

	const handlePlatform = (next: string) => {
		const nextPlatform = next as ImPlatform;
		setPlatform(nextPlatform);
		emit(nextPlatform, chatId);
	};

	const handleChatId = (raw: string) => {
		setChatId(raw);
		emit(platform, raw);
	};

	const handleClear = () => {
		setChatId("");
		onChange(null);
	};

	const trimmedChatId = chatId.trim();
	const kindHint = platform === "lark" && trimmedChatId ? inferLarkKindLabel(trimmedChatId) : null;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<RadixSelect.Root value={platform} onValueChange={handlePlatform} disabled={disabled}>
					<RadixSelect.Trigger
						aria-label="IM platform"
						className="flex h-8 w-28 shrink-0 items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none hover:bg-surface-3 focus:border-border-focus disabled:opacity-50"
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

				<div className="relative flex-1">
					<input
						type="text"
						aria-label="IM chat ID"
						value={chatId}
						disabled={disabled}
						onChange={(event) => handleChatId(event.target.value)}
						placeholder="粘贴群 / 单聊 ID，如 oc_…"
						className="h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2.5 pr-7 text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-border-focus disabled:opacity-50"
					/>
					{trimmedChatId ? (
						<button
							type="button"
							onClick={handleClear}
							disabled={disabled}
							aria-label="清除 IM chat ID"
							className="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-text-tertiary hover:text-text-primary"
						>
							<X size={13} />
						</button>
					) : null}
				</div>
			</div>

			<p className="text-[11px] text-text-tertiary">
				{kindHint ? (
					<>
						识别为:<span className="text-text-secondary">{kindHint}</span>
					</>
				) : (
					"飞书群设置 → 更多 → 复制群 ID。留空表示不绑定。"
				)}
			</p>
		</div>
	);
}
