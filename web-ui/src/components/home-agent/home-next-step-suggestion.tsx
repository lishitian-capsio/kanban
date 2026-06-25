// A single clickable "next step" suggestion chip for the home sidebar chat.
//
// The thread's own agent proposes one ready-to-send next-step prompt at the end of a turn
// (via `kanban home-thread suggest-next`), persisted as the thread's transient
// `pendingNextStep`. This renders it as one button just above the composer; clicking it
// sends the text verbatim as the next user message (the same path as typing it and pressing
// enter). The user can also ignore it — it clears when they send any message or the agent
// supersedes it.

import { CornerDownLeft, Sparkles } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

interface HomeNextStepSuggestionProps {
	suggestion: string;
	onSend: (suggestion: string) => void;
	disabled?: boolean;
}

export function HomeNextStepSuggestion({
	suggestion,
	onSend,
	disabled = false,
}: HomeNextStepSuggestionProps): ReactElement {
	return (
		<Button
			variant="default"
			fill
			disabled={disabled}
			onClick={() => onSend(suggestion)}
			title="Send this as your next message"
			icon={<Sparkles size={14} className="shrink-0 text-status-purple" />}
			iconRight={<CornerDownLeft size={14} className="shrink-0 text-text-tertiary" />}
			className="h-auto items-start justify-start gap-2 whitespace-normal py-1.5 text-left text-text-secondary hover:text-text-primary"
		>
			<span className="line-clamp-2 min-w-0 flex-1 leading-snug">{suggestion}</span>
		</Button>
	);
}
