// Compact, non-sensitive session metadata chips shared by the board task card and
// the home session card. Sourced entirely from the live `RuntimeTaskSessionSummary`
// both cards already hold, so there is no new data path: the provider name
// (== providerId) and the resolved model id are surfaced together in one chip, and
// the session's cumulative token usage in another. API keys / base URLs are never
// part of the summary, so nothing sensitive can leak here.
//
// Every field degrades gracefully: a chip renders only when its data is present,
// and the component renders nothing at all when the summary is absent or empty
// (e.g. a backlog task with no session, or a CLI agent that has no token
// telemetry).
import { Coins, Cpu } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

interface SessionMetaBadgesProps {
	summary: RuntimeTaskSessionSummary | null | undefined;
	/** Use the muted (trashed/settled) chip palette instead of the default. */
	muted?: boolean;
	className?: string;
}

/** 1234 → "1.2k", 1_200_000 → "1.2M". Keeps the chip narrow on a dense card. */
export function formatTokenCount(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
	}
	return `${(value / 1_000_000).toFixed(1)}M`;
}

export function SessionMetaBadges({ summary, muted, className }: SessionMetaBadgesProps): React.ReactElement | null {
	const providerId = summary?.providerId?.trim() || null;
	const modelId = summary?.modelId?.trim() || null;
	const usage = summary?.usage ?? null;
	const totalTokens = usage && usage.totalTokens > 0 ? usage.totalTokens : null;

	const providerModelLabel = [providerId, modelId].filter((value): value is string => Boolean(value)).join(" · ");

	if (!providerModelLabel && totalTokens == null) {
		return null;
	}

	const chipClass = cn(
		"inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
		muted ? "border-border bg-surface-1 text-text-tertiary" : "border-border-bright bg-surface-1 text-text-secondary",
	);

	return (
		<div className={cn("flex flex-wrap items-center gap-1", className)}>
			{providerModelLabel ? (
				<span
					className={chipClass}
					title={[providerId ? `Provider: ${providerId}` : null, modelId ? `Model: ${modelId}` : null]
						.filter(Boolean)
						.join("\n")}
				>
					<Cpu size={12} className="shrink-0" />
					<span className="truncate">{providerModelLabel}</span>
				</span>
			) : null}
			{totalTokens != null && usage ? (
				<span
					className={chipClass}
					title={`Tokens — in ${usage.inputTokens.toLocaleString()} · out ${usage.outputTokens.toLocaleString()} · total ${totalTokens.toLocaleString()}`}
				>
					<Coins size={12} className="shrink-0" />
					<span className="truncate">{formatTokenCount(totalTokens)} tok</span>
				</span>
			) : null}
		</div>
	);
}
