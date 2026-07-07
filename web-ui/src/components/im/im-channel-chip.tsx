import { MessageCircle, X } from "lucide-react";
import type { ReactElement } from "react";

import { describeImChannel, type ImChannelTarget, imChannelDisplayLabel } from "@/components/im/im-channel";
import { cn } from "@/components/ui/cn";

interface ImChannelChipProps {
	channel: ImChannelTarget;
	/** Human-readable chat name. When present it is shown; the raw chatId falls back to a hover title. */
	displayName?: string | null;
	onUnbind?: () => void;
	className?: string;
}

export function ImChannelChip({ channel, displayName, onUnbind, className }: ImChannelChipProps): ReactElement {
	const { platformLabel, kindLabel } = describeImChannel(channel);
	const label = `${platformLabel} · ${kindLabel}`;
	const primary = imChannelDisplayLabel(channel.chatId, displayName);
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-secondary",
				className,
			)}
		>
			<MessageCircle size={13} className="shrink-0 text-text-tertiary" />
			<span className="shrink-0">{label}</span>
			<span
				className={cn(
					"max-w-[160px] truncate text-text-secondary",
					!displayName?.trim() && "font-mono text-text-tertiary",
				)}
				title={channel.chatId}
			>
				{primary}
			</span>
			{onUnbind ? (
				<button
					type="button"
					onClick={onUnbind}
					aria-label={`解绑 ${label}`}
					className="shrink-0 cursor-pointer text-text-tertiary transition-colors hover:text-text-primary"
				>
					<X size={12} />
				</button>
			) : null}
		</span>
	);
}
