import { FileText, X } from "lucide-react";
import type { ReactElement } from "react";
import type { PromptAttachment } from "@/components/prompt-attachments/use-prompt-file-attachments";
import { cn } from "@/components/ui/cn";

interface PromptAttachmentChipsProps {
	attachments: PromptAttachment[];
	onRemove: (id: string) => void;
	className?: string;
}

/**
 * Removable chips for collected non-image file attachments. Shared by the task
 * create dialog and the new-thread create dialog so both surfaces render the
 * same affordance. Renders nothing when there are no attachments.
 */
export function PromptAttachmentChips({
	attachments,
	onRemove,
	className,
}: PromptAttachmentChipsProps): ReactElement | null {
	if (attachments.length === 0) {
		return null;
	}
	return (
		<div className={cn("flex flex-wrap gap-1.5", className)}>
			{attachments.map((attachment) => (
				<span
					key={attachment.id}
					className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px] text-text-secondary"
				>
					<FileText size={13} className="shrink-0 text-text-tertiary" />
					<span className="max-w-[180px] truncate" title={attachment.path}>
						{attachment.name}
					</span>
					<button
						type="button"
						onClick={() => onRemove(attachment.id)}
						aria-label={`Remove ${attachment.name}`}
						className="shrink-0 cursor-pointer text-text-tertiary transition-colors hover:text-text-primary"
					>
						<X size={12} />
					</button>
				</span>
			))}
		</div>
	);
}
