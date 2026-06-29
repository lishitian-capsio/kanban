// The shared thread-instance identity atom: **agent avatar + overlaid status dot +
// thread title**, always leading, title following. Per the unification decision
// (vault `decision/d746c`, rule 1) this single primitive backs all four 会话-agent
// surfaces — the launcher card (①), the session tab strip (②), the compact thread
// dropdown (③), and the Pi session rail (④) — so the "avatar, then status, then
// name" signature reads identically in board mode and session mode.
//
// What used to diverge and is now unified here:
//   - icon size/box/order → one boxed {@link AgentAvatar}, always leading (fixes
//     ②③ which trailed a bare icon; gives ④ the avatar it lacked).
//   - status visibility → a corner status badge rides the avatar in every variant
//     (gives ②③ a status indicator they previously lacked — the headline win).
//   - title weight → bold + primary when active, normal + secondary when not (rule 3).
//
// Status semantics stay owned by `home-session-card-derive.ts` /
// `home-session-card-status-marker.tsx`; this component only composes them.
import type { ReactElement, ReactNode } from "react";

import { AgentAvatar } from "@/components/home-agent/agent-icon";
import type { HomeSessionCardStatusDescriptor } from "@/components/home-agent/home-session-card-derive";
import { HomeSessionCardStatusMarker } from "@/components/home-agent/home-session-card-status-marker";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

export type SessionAgentIdentityVariant = "card" | "tab" | "dropdown-item" | "rail-item";

interface SessionAgentIdentityProps {
	agents: RuntimeAgentDefinition[];
	agentId: RuntimeAgentId;
	/** The thread's derived status — drives the corner badge marker + its accessible name. */
	status: HomeSessionCardStatusDescriptor;
	/** The thread title (shown unless `titleSlot` overrides it). */
	title: string;
	/** Active/selected — drives the title weight (rule 3). */
	isActive: boolean;
	variant: SessionAgentIdentityVariant;
	/** Replaces the rendered title (e.g. the card's inline rename input). The avatar + status still render. */
	titleSlot?: ReactNode;
	/** Rendered right after the title, inside the same min-w-0 row (e.g. the card's inline rename pencil). */
	titleTrailing?: ReactNode;
	/** Class on the outer flex wrapper (e.g. `flex-1`). */
	className?: string;
	/** Class merged onto the title text. */
	titleClassName?: string;
}

export function SessionAgentIdentity({
	agents,
	agentId,
	status,
	title,
	isActive,
	variant,
	titleSlot,
	titleTrailing,
	className,
	titleClassName,
}: SessionAgentIdentityProps): ReactElement {
	const avatarSize = variant === "card" ? "md" : "sm";
	return (
		<span className={cn("flex min-w-0 items-center", variant === "card" ? "gap-2" : "gap-1.5", className)}>
			<AgentAvatar agents={agents} agentId={agentId} size={avatarSize}>
				{/* Corner status badge — backed by the same `bg-surface-1` as the avatar box so
				    it reads consistently regardless of the surface behind the row/tile. */}
				<span
					className="absolute -bottom-1 -right-1 inline-flex items-center justify-center rounded-full bg-surface-1"
					role="img"
					aria-label={status.label}
					title={status.label}
				>
					<HomeSessionCardStatusMarker status={status} />
				</span>
			</AgentAvatar>
			{titleSlot ?? (
				<span
					className={cn(
						"min-w-0 truncate text-[13px]",
						isActive ? "font-medium text-text-primary" : "font-normal text-text-secondary",
						titleClassName,
					)}
				>
					{title}
				</span>
			)}
			{titleTrailing}
		</span>
	);
}
