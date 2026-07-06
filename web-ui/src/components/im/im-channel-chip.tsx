import { MessageCircle, X } from "lucide-react";
import type { ReactElement } from "react";

import { describeImChannel, type ImChannelTarget } from "@/components/im/im-channel";
import { cn } from "@/components/ui/cn";

interface ImChannelChipProps {
	channel: ImChannelTarget;
	onUnbind?: () => void;
	className?: string;
}

export function ImChannelChip({ channel, onUnbind, className }: ImChannelChipProps): ReactElement {
	const { platformLabel, kindLabel } = describeImChannel(channel);
	const label = `${platformLabel} · ${kindLabel}`;
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-secondary",
				className,
			)}
		>
			<MessageCircle size={13} className="shrink-0 text-text-tertiary" />
			<span className="shrink-0">{label}</span>
			<span className="max-w-[160px] truncate font-mono text-text-tertiary" title={channel.chatId}>
				{channel.chatId}
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
