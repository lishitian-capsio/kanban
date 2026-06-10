import { History } from "lucide-react";
import type React from "react";

import { Spinner } from "@/components/ui/spinner";
import type { RuntimeRequirementChangeKind, RuntimeRequirementChangeSource, RuntimeRequirementVersion } from "@/runtime/types";
import { formatRequirementVersionLabel } from "@runtime-requirement-versions";

interface RequirementVersionHistoryProps {
	versions: RuntimeRequirementVersion[];
	isLoading: boolean;
	errorMessage: string | null;
}

const CHANGE_KIND_LABELS: Record<RuntimeRequirementChangeKind, string> = {
	create: "Created",
	update: "Updated",
	delete: "Deleted",
	revert: "Reverted",
};

const SOURCE_LABELS: Record<RuntimeRequirementChangeSource, string> = {
	human: "Human",
	agent: "Agent",
};

function formatTimestamp(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function RequirementVersionHistory({
	versions,
	isLoading,
	errorMessage,
}: RequirementVersionHistoryProps): React.ReactElement {
	// Newest version first so the latest change is immediately visible.
	const ordered = [...versions].sort((left, right) => right.version - left.version);

	return (
		<div className="flex flex-col gap-1.5 px-5 py-4">
			<div className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
				<History size={14} />
				<span>Version history</span>
			</div>

			{errorMessage ? (
				<p className="text-[13px] text-status-red">{errorMessage}</p>
			) : isLoading && ordered.length === 0 ? (
				<div className="flex items-center gap-2 py-2 text-[13px] text-text-tertiary">
					<Spinner size={14} />
					<span>Loading history…</span>
				</div>
			) : ordered.length === 0 ? (
				<p className="text-[13px] text-text-tertiary">No version history yet.</p>
			) : (
				<ol className="flex flex-col gap-1.5">
					{ordered.map((version) => (
						<li
							key={version.version}
							className="flex items-start gap-3 rounded-md border border-border bg-surface-2 px-3 py-2"
						>
							<span
								data-testid="requirement-version-label"
								className="shrink-0 rounded-sm bg-surface-3 px-1.5 py-0.5 font-mono text-[12px] font-medium text-text-primary"
							>
								{formatRequirementVersionLabel(version.version)}
							</span>
							<div className="flex min-w-0 flex-col gap-0.5">
								<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-text-primary">
									<span className="font-medium">{CHANGE_KIND_LABELS[version.changeKind]}</span>
									<span className="text-text-tertiary">·</span>
									<span className="text-text-secondary">{SOURCE_LABELS[version.source]}</span>
									<span className="text-text-tertiary">·</span>
									<time className="text-text-tertiary" dateTime={new Date(version.createdAt).toISOString()}>
										{formatTimestamp(version.createdAt)}
									</time>
								</div>
								{version.reason ? <p className="text-[12px] text-text-secondary">{version.reason}</p> : null}
							</div>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
