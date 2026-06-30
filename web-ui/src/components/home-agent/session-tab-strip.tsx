// The horizontal tab strip for the fullscreen home workspace (decision 1902b).
//
// The leftmost tab is the permanent Home anchor (the launcher / session-card dashboard); it is
// always present and cannot be closed. To its right sit the coexisting non-pi session tabs, one
// per open thread, which the user switches between horizontally. (Pi sessions are NOT tabs — they
// live in the permanent Pi rail to the left of this strip, in both modes.) Closing a session tab
// is a UI-only collapse back to Home — it never hard-closes the thread (that stays an explicit
// action in the launcher / thread bar). Only the session-tab region scrolls horizontally when the
// tabs overflow; the Home anchor stays pinned and visible.
import { createHomeAgentSessionId } from "@runtime-home-agent-session";
import { FileText, LayoutGrid, X } from "lucide-react";
import { type ReactElement, useEffect, useRef } from "react";

import { deriveHomeSessionCardStatus } from "@/components/home-agent/home-session-card-derive";
import { getActiveHighlightClass } from "@/components/home-agent/session-active-highlight";
import { SessionAgentIdentity } from "@/components/home-agent/session-agent-identity";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition, RuntimeTaskSessionSummary } from "@/runtime/types";

interface SessionTabStripProps {
	threads: HomeThread[];
	openThreadIds: string[];
	/** The active tab's thread id, or null when the Home tab is active. */
	activeThreadId: string | null;
	/**
	 * Whether a pi session conversation is currently showing (selected in the Pi rail). When true
	 * the strip highlights NO tab — neither Home nor a session tab — because the pi rail owns the
	 * view; clicking any tab here clears that pi selection upstream.
	 */
	piConversationActive: boolean;
	agents: RuntimeAgentDefinition[];
	/** Workspace id used to resolve each thread's session id for its status dot. */
	currentProjectId: string;
	/** Per-session summaries that drive each tab's status badge (rule 1: tabs now show status). */
	taskSessions: Record<string, RuntimeTaskSessionSummary>;
	onActivateHome: () => void;
	onActivateTab: (threadId: string) => void;
	onCloseTab: (threadId: string) => void;
	/** Open the File surface library overlay (portaled above this workspace). */
	onOpenFile?: () => void;
}

export function SessionTabStrip({
	threads,
	openThreadIds,
	activeThreadId,
	piConversationActive,
	agents,
	currentProjectId,
	taskSessions,
	onActivateHome,
	onActivateTab,
	onCloseTab,
	onOpenFile,
}: SessionTabStripProps): ReactElement {
	// While a pi session conversation owns the view, neither Home nor any session tab is highlighted.
	const homeActive = activeThreadId === null && !piConversationActive;

	// Keep the active tab scrolled into view: when many session tabs overflow their
	// scroll region, activating one (or opening a new one) that sits past the visible
	// range would otherwise leave the user with no on-strip focus marker. We query the
	// active tab via a data attribute on the container so a single ref covers the Home,
	// Pi, and session tabs without juggling element-typed refs. `scrollIntoView`
	// targets the nearest scrollable ancestor, so it's a no-op for the pinned anchor
	// tabs and only scrolls the session-tab region. `inline/block: nearest` confines
	// the scroll to that region (no whole-page jump); the first paint uses `auto` so
	// restoring persisted tabs doesn't animate.
	const stripRef = useRef<HTMLDivElement | null>(null);
	const hasScrolledRef = useRef(false);
	useEffect(() => {
		const activeTab = stripRef.current?.querySelector<HTMLElement>('[data-active-tab="true"]');
		if (!activeTab) {
			return;
		}
		activeTab.scrollIntoView({
			behavior: hasScrolledRef.current ? "smooth" : "auto",
			inline: "nearest",
			block: "nearest",
		});
		hasScrolledRef.current = true;
	}, [activeThreadId, piConversationActive]);

	return (
		<div
			ref={stripRef}
			role="tablist"
			aria-label="Home agent sessions"
			className="flex shrink-0 items-stretch gap-1 border-b border-border pb-1"
		>
			{/* Anchored Home tab — pinned outside the scroll region so it never scrolls away. */}
			<div className="flex flex-none items-stretch gap-1">
				<button
					type="button"
					role="tab"
					aria-selected={homeActive}
					data-active-tab={homeActive ? "true" : undefined}
					onClick={onActivateHome}
					title="Home — all sessions"
					className={cn(
						"flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:border-border-focus",
						getActiveHighlightClass("tab", homeActive),
						homeActive && "font-medium",
					)}
				>
					<LayoutGrid size={14} className="shrink-0" aria-hidden="true" />
					<span>Home</span>
				</button>
			</div>

			{/* Session tabs scroll horizontally. The scrollbar is fully hidden (no reserved/consumed
			    space) so a bottom horizontal bar can't shrink this region's content box and ride the
			    session tabs up relative to the no-scrollbar anchored region; the active tab is kept
			    in view via scrollIntoView, and wheel/trackpad still scroll the overflow. */}
			<div className="scrollbar-hidden flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
				{openThreadIds.map((threadId) => {
					const thread = threads.find((candidate) => candidate.id === threadId);
					if (!thread) {
						return null;
					}
					const isActive = threadId === activeThreadId && !piConversationActive;
					const sessionTaskId = createHomeAgentSessionId(currentProjectId, thread.agentId, thread.id);
					const status = deriveHomeSessionCardStatus(taskSessions[sessionTaskId] ?? null);
					return (
						<div
							key={threadId}
							data-active-tab={isActive ? "true" : undefined}
							className={cn(
								"flex shrink-0 items-center gap-1.5 rounded-md pl-2.5 pr-1.5 py-1.5 transition-colors",
								getActiveHighlightClass("tab", isActive),
							)}
						>
							<button
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => onActivateTab(threadId)}
								className="flex min-w-0 max-w-[180px] cursor-pointer items-center outline-none"
								title={thread.name}
							>
								{/* Unified identity atom: the avatar now leads (was a trailing bare icon)
								    and carries the status badge the tab strip previously lacked (rule 1). */}
								<SessionAgentIdentity
									agents={agents}
									agentId={thread.agentId}
									status={status}
									title={thread.name}
									isActive={isActive}
									variant="tab"
									className="min-w-0"
								/>
							</button>
							<button
								type="button"
								aria-label={`Close ${thread.name} tab`}
								title="Collapse this tab back to Home"
								onClick={() => onCloseTab(threadId)}
								className="flex shrink-0 cursor-pointer items-center rounded-sm p-0.5 text-text-tertiary hover:bg-surface-4 hover:text-text-primary"
							>
								<X size={13} />
							</button>
						</div>
					);
				})}
			</div>

			{/* Trailing action, pinned outside the scroll region so it stays reachable in
			    fullscreen/session mode regardless of how many session tabs overflow. Opens
			    the same File surface library overlay as the board top bar — a portaled
			    overlay that layers above this workspace without unmounting it. */}
			{onOpenFile ? (
				<div className="flex flex-none items-stretch">
					<button
						type="button"
						onClick={onOpenFile}
						title="Files"
						aria-label="Open files"
						className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-3 hover:text-text-primary focus-visible:border-border-focus"
					>
						<FileText size={14} className="shrink-0" aria-hidden="true" />
						<span>File</span>
					</button>
				</div>
			) : null}
		</div>
	);
}
