import { Cpu, MemoryStick } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { OpsSparkline } from "@/components/home-agent/ops-sparkline";
import { useRuntimeOpsMetrics, useRuntimeOpsMetricsHistory } from "@/runtime/runtime-stream-store";

// Bottom status bar for the unified Kanban-agent sidebar — a thin, VSCode-style
// readout of the runtime process's live ops metrics (resident memory, CPU%, and
// event-loop stall state).
//
// It is mounted at the bottom of the sidebar's flexible container
// (`dockable-chat-panel.tsx` → `DockHeaderWithChildren`), so it travels with the
// sidebar when docked left/right or floated and is hidden when the sidebar
// collapses to its edge strip.
//
// Per the runtime-store leaf-subscription rule (web-ui perf model), the
// high-frequency metrics slice is subscribed HERE, inside this leaf component, so
// the ~2.5s `runtime_metrics_updated` broadcast re-renders only this bar and not
// the whole app.

/** Format a byte count as a compact `MB`/`GB` string for the status bar. */
function formatRss(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	if (megabytes >= 1024) {
		return `${(megabytes / 1024).toFixed(1)}GB`;
	}
	return `${Math.round(megabytes)}MB`;
}

/** Format a CPU percentage as a compact integer string (can exceed 100%). */
function formatCpuPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

export function SidebarOpsStatusBar(): ReactElement | null {
	const metrics = useRuntimeOpsMetrics();
	const history = useRuntimeOpsMetricsHistory();
	if (!metrics) {
		return null;
	}

	const stalled = metrics.eventLoopStalled;
	const rssSeries = history.map((sample) => sample.rssBytes);
	const cpuSeries = history.map((sample) => sample.cpuPercent);

	return (
		<div
			className="-mx-2 -mb-2 flex items-center gap-3 border-t border-border px-2 py-1 text-[11px] text-text-secondary tabular-nums select-none"
			data-testid="sidebar-ops-status-bar"
		>
			<Tooltip side="top" content="Runtime process resident memory (RSS), trend over the last ~2.5 minutes">
				<span className="inline-flex items-center gap-1">
					<MemoryStick size={12} className="text-text-tertiary" />
					{formatRss(metrics.rssBytes)}
					<OpsSparkline values={rssSeries} className="text-status-blue" />
				</span>
			</Tooltip>
			<Tooltip
				side="top"
				content="Runtime process CPU usage (sums across cores, so it can exceed 100%), trend over the last ~2.5 minutes"
			>
				<span className="inline-flex items-center gap-1">
					<Cpu size={12} className="text-text-tertiary" />
					{formatCpuPercent(metrics.cpuPercent)}
					<OpsSparkline values={cpuSeries} className="text-status-green" />
				</span>
			</Tooltip>
			<Tooltip
				side="top"
				content={
					stalled
						? "Event loop stalled — the runtime is blocked (likely a synchronous loop or blocking call)"
						: "Event loop healthy"
				}
			>
				<span className="inline-flex items-center gap-1">
					<span
						className={cn("h-1.5 w-1.5 rounded-full", stalled ? "bg-status-red" : "bg-status-green")}
						aria-hidden
					/>
					<span>{stalled ? "Stalled" : "Healthy"}</span>
				</span>
			</Tooltip>
		</div>
	);
}
