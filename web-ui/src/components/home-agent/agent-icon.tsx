// Compact agent identity glyph reused across the home surfaces.
//
// The fullscreen session tabs, the sidebar thread switcher, and the launcher cards
// all need to show *which agent* backs a thread without spelling out the name every
// time (that was the old uppercase ThreadAgentBadge, which turned into visual noise
// when repeated per tab/row/card). Instead we render a single ~14px icon and surface
// the full agent name only on hover (title/aria-label), so the name is reachable but
// never repeated. The agent's full name is shown in prose exactly once — in the active
// conversation's provider·model header.
//
// Pi's anchor tab already uses lucide's Bot icon; this map keeps that style and extends
// it per agent, falling back to Bot for any agent without an explicit glyph so a new
// catalog entry never renders blank.
import { Bot, Code, Gem, Hexagon, type LucideIcon, Sparkles, SquareCode, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";

export function resolveAgentLabel(agents: RuntimeAgentDefinition[], agentId: RuntimeAgentId): string {
	return agents.find((agent) => agent.id === agentId)?.label ?? agentId;
}

interface AgentGlyph {
	icon: LucideIcon;
	/** Tailwind text-color class (status-* brand tint, kept subtle at icon scale). */
	colorClass: string;
}

const FALLBACK_GLYPH: AgentGlyph = { icon: Bot, colorClass: "text-text-secondary" };

// Per-agent glyph + subtle brand tint. Unknown agents degrade to the Bot fallback.
const AGENT_GLYPHS: Record<string, AgentGlyph> = {
	pi: { icon: Bot, colorClass: "text-status-purple" },
	claude: { icon: Sparkles, colorClass: "text-status-orange" },
	codex: { icon: SquareCode, colorClass: "text-status-green" },
	gemini: { icon: Gem, colorClass: "text-status-blue" },
	droid: { icon: Bot, colorClass: "text-status-gold" },
	kiro: { icon: Hexagon, colorClass: "text-status-red" },
	opencode: { icon: Code, colorClass: "text-status-blue" },
	qoder: { icon: SquareTerminal, colorClass: "text-status-purple" },
};

/**
 * Small icon standing in for a thread's agent. The full agent name is exposed via
 * `title`/`aria-label` (hover tooltip + accessible/testable name), so no readable
 * information is lost despite dropping the text label.
 */
export function AgentIcon({
	agents,
	agentId,
	size = 14,
	className,
}: {
	agents: RuntimeAgentDefinition[];
	agentId: RuntimeAgentId;
	size?: number;
	className?: string;
}): React.ReactElement {
	const label = resolveAgentLabel(agents, agentId);
	const glyph = AGENT_GLYPHS[agentId] ?? FALLBACK_GLYPH;
	const Icon = glyph.icon;
	return (
		<span
			className={cn("inline-flex shrink-0 items-center justify-center", glyph.colorClass, className)}
			role="img"
			aria-label={label}
			title={label}
		>
			<Icon size={size} aria-hidden="true" />
		</span>
	);
}

/**
 * The standardized "avatar" treatment for a thread's agent: the {@link AgentIcon}
 * centered in one consistent small bordered box, always leading. This is the shared
 * denominator the unification decision (vault `decision/d746c`) calls for — every
 * 会话-agent surface (session card, tab, dropdown, rail) and the agent-type surfaces
 * (conversation header, create dialog) render the icon through this same box so the
 * glyph reads identically everywhere.
 *
 * `children` is an overlay slot: the thread-instance surfaces pass a corner status
 * badge here; the agent-type surfaces pass nothing.
 */
export function AgentAvatar({
	agents,
	agentId,
	size = "sm",
	className,
	children,
}: {
	agents: RuntimeAgentDefinition[];
	agentId: RuntimeAgentId;
	/** `sm` (20px box / 14px icon) for rows + agent-type surfaces; `md` (28px / 16px) for the launcher card. */
	size?: "sm" | "md";
	className?: string;
	children?: ReactNode;
}): React.ReactElement {
	const box = size === "md" ? "size-7" : "size-5";
	const iconSize = size === "md" ? 16 : 14;
	return (
		<span
			className={cn(
				"relative inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface-1",
				box,
				className,
			)}
		>
			<AgentIcon agents={agents} agentId={agentId} size={iconSize} />
			{children}
		</span>
	);
}
