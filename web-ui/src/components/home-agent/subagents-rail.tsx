// The subagents rail for the single Pi conversation area (decision 647ea / X1).
//
// Pi's concurrency is a main agent + subagents (child `task`-tool runs), NOT multiple
// peer Pi sessions. This rail carries that: row 0 is the main agent, followed by one row
// per subagent projected onto the parent session summary (`summary.subagents`). Selecting
// a row is the ONLY state it owns — the parent surface swaps the single active transcript
// subscription to the chosen row. The rail opens no per-subagent subscriptions of its own
// (leaf-fiber rule): status/tokens come straight off the parent summary the surface already
// subscribes to.
import type { ReactElement } from "react";

import { formatTokenCount } from "@/components/session-meta-badges";
import { deriveHomeSessionCardStatus, deriveSubagentStatus } from "@/components/home-agent/home-session-card-derive";
import { SessionAgentIdentity } from "@/components/home-agent/session-agent-identity";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeTaskSessionSummary, RuntimeTaskSubagent } from "@/runtime/types";

export interface SubagentsRailProps {
	agents: RuntimeAgentDefinition[];
	/** The parent Pi session summary — drives the main row's status. */
	mainSummary: RuntimeTaskSessionSummary | null;
	/** Subagents projected onto the parent summary; null/empty ⇒ only the main row shows. */
	subagents: RuntimeTaskSubagent[] | null | undefined;
	/** The currently drilled-into subagent, or null when viewing the main transcript. */
	selectedSubagentId: string | null;
	/** Select a subagent to drill into (null selects the main transcript). */
	onSelect: (subagentId: string | null) => void;
	/** Docked → a horizontal strip below the transcript; fullscreen → a vertical right column. */
	orientation: "docked" | "fullscreen";
}

const PI_AGENT_ID = "pi" as const;

export function SubagentsRail({
	agents,
	mainSummary,
	subagents,
	selectedSubagentId,
	onSelect,
	orientation,
}: SubagentsRailProps): ReactElement {
	const rows = subagents ?? [];
	const isFullscreen = orientation === "fullscreen";
	return (
		<div
			className={cn(
				"flex min-h-0 shrink-0 gap-1 border-border",
				isFullscreen
					? "w-48 flex-col overflow-y-auto border-l pl-2"
					: "flex-row items-center overflow-x-auto border-t pt-2",
			)}
		>
			<div
				className={cn(
					"shrink-0 px-1 text-[11px] font-medium uppercase tracking-wide text-text-tertiary",
					isFullscreen ? "pb-1" : "self-center",
				)}
			>
				Agents
			</div>
			<SubagentRow
				agents={agents}
				agentId={PI_AGENT_ID}
				title="Main"
				status={deriveHomeSessionCardStatus(mainSummary)}
				tokens={mainSummary?.usage?.totalTokens ?? null}
				isActive={selectedSubagentId === null}
				onClick={() => onSelect(null)}
			/>
			{rows.map((subagent) => (
				<SubagentRow
					key={subagent.subagentId}
					agents={agents}
					agentId={PI_AGENT_ID}
					title={subagent.label}
					status={deriveSubagentStatus(subagent.status)}
					tokens={subagent.usage?.totalTokens ?? null}
					isActive={selectedSubagentId === subagent.subagentId}
					onClick={() => onSelect(subagent.subagentId)}
				/>
			))}
		</div>
	);
}

interface SubagentRowProps {
	agents: RuntimeAgentDefinition[];
	agentId: typeof PI_AGENT_ID;
	title: string;
	status: ReturnType<typeof deriveHomeSessionCardStatus>;
	tokens: number | null;
	isActive: boolean;
	onClick: () => void;
}

function SubagentRow({ agents, agentId, title, status, tokens, isActive, onClick }: SubagentRowProps): ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={isActive}
			className={cn(
				"flex min-w-0 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
				isActive ? "bg-surface-3" : "hover:bg-surface-2",
			)}
		>
			<SessionAgentIdentity
				agents={agents}
				agentId={agentId}
				status={status}
				title={title}
				isActive={isActive}
				variant="rail-item"
				className="min-w-0"
			/>
			{tokens != null && tokens > 0 ? (
				<span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{formatTokenCount(tokens)}</span>
			) : null}
		</button>
	);
}
