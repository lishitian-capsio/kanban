// The horizontal tab strip for the fullscreen home workspace (decision 1902b).
//
// The leftmost tabs are the permanent anchors — Home (the launcher / session-card dashboard)
// and Pi (native-agent workspace); they are always present and cannot be closed. To their
// right sit the coexisting session tabs, one per open thread, which the user switches between
// horizontally. Closing a session tab is a UI-only collapse back to Home — it never hard-closes
// the thread (that stays an explicit action in the launcher / thread bar). Only the session-tab
// region scrolls horizontally when the tabs overflow; the anchored tabs stay pinned and visible.
import { Bot, LayoutGrid, X } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";

import { ThreadAgentBadge } from "@/components/home-agent/thread-agent-badge";
import { cn } from "@/components/ui/cn";
import type { HomeThread } from "@/hooks/use-home-threads";
import type { RuntimeAgentDefinition } from "@/runtime/types";

interface SessionTabStripProps {
	threads: HomeThread[];
	openThreadIds: string[];
	/** The active tab's thread id, or null when the Home tab is active. */
	activeThreadId: string | null;
	/** Whether the fixed Pi tab (native-agent multi-session workspace) is the active tab. */
	piTabActive: boolean;
	agents: RuntimeAgentDefinition[];
	onActivateHome: () => void;
	onActivatePi: () => void;
	onActivateTab: (threadId: string) => void;
	onCloseTab: (threadId: string) => void;
}

export function SessionTabStrip({
	threads,
	openThreadIds,
	activeThreadId,
	piTabActive,
	agents,
	onActivateHome,
	onActivatePi,
	onActivateTab,
	onCloseTab,
}: SessionTabStripProps): ReactElement {
	// The Pi tab is a peer of the Home tab; while it is active neither Home
	// nor any session tab is highlighted.
	const homeActive = activeThreadId === null && !piTabActive;

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
	}, [activeThreadId, piTabActive]);

	return (
		<div
			ref={stripRef}
			role="tablist"
			aria-label="Home agent sessions"
			className="flex shrink-0 items-stretch gap-1 border-b border-border pb-1"
		>
			{/* Anchored tabs — pinned outside the scroll region so they never scroll away. */}
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
						homeActive
							? "bg-surface-2 font-medium text-text-primary"
							: "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
					)}
				>
					<LayoutGrid size={14} className="shrink-0" aria-hidden="true" />
					<span>Home</span>
				</button>

				<button
					type="button"
					role="tab"
					aria-selected={piTabActive}
					data-active-tab={piTabActive ? "true" : undefined}
					onClick={onActivatePi}
					title="Pi — native agent sessions"
					className={cn(
						"flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-visible:border-border-focus",
						piTabActive
							? "bg-surface-2 font-medium text-text-primary"
							: "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
					)}
				>
					<Bot size={14} className="shrink-0" aria-hidden="true" />
					<span>Pi</span>
				</button>
			</div>

			{/* Session tabs scroll horizontally; the overlay scrollbar is hidden until hover. */}
			<div className="scrollbar-overlay flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
				{openThreadIds.map((threadId) => {
					const thread = threads.find((candidate) => candidate.id === threadId);
					if (!thread) {
						return null;
					}
					const isActive = threadId === activeThreadId && !piTabActive;
					return (
						<div
							key={threadId}
							data-active-tab={isActive ? "true" : undefined}
							className={cn(
								"flex shrink-0 items-center gap-1.5 rounded-md pl-2.5 pr-1.5 py-1.5 text-[13px] transition-colors",
								isActive
									? "bg-surface-2 text-text-primary"
									: "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
							)}
						>
							<button
								type="button"
								role="tab"
								aria-selected={isActive}
								onClick={() => onActivateTab(threadId)}
								className="flex min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 outline-none"
								title={thread.name}
							>
								<span className={cn("min-w-0 truncate", isActive && "font-medium")}>{thread.name}</span>
								<ThreadAgentBadge agents={agents} agentId={thread.agentId} />
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
		</div>
	);
}
