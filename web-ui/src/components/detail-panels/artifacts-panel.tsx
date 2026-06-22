import { FileCode2, FileJson, FileText, Image as ImageIcon, Package, Sparkles, Table2 } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
	type ArtifactIconKind,
	groupArtifactsByType,
	resolveArtifactIconKind,
} from "@/components/detail-panels/artifact-grouping";
import { ArtifactViewer } from "@/components/detail-panels/artifact-viewer";
import { cn } from "@/components/ui/cn";
import type { RuntimeArtifact } from "@/runtime/types";
import { useRuntimeArtifactContent } from "@/runtime/use-runtime-artifact-content";

function ArtifactIcon({ kind }: { kind: ArtifactIconKind }): React.ReactElement {
	const size = 14;
	switch (kind) {
		case "image":
			return <ImageIcon size={size} className="text-status-purple" />;
		case "json":
			return <FileJson size={size} className="text-status-orange" />;
		case "table":
			return <Table2 size={size} className="text-status-green" />;
		case "binary":
			return <Package size={size} className="text-text-tertiary" />;
		case "text":
			return <FileCode2 size={size} className="text-status-blue" />;
		default:
			return <FileText size={size} className="text-status-blue" />;
	}
}

function ArtifactRow({
	artifact,
	isSelected,
	onSelect,
}: {
	artifact: RuntimeArtifact;
	isSelected: boolean;
	onSelect: () => void;
}): React.ReactElement {
	const name = artifact.path.split("/").pop() ?? artifact.path;
	const dir = artifact.path.slice(0, artifact.path.length - name.length).replace(/\/$/, "");
	return (
		<button
			type="button"
			onClick={onSelect}
			title={artifact.path}
			className={cn(
				"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors",
				isSelected ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:bg-surface-2",
			)}
		>
			<ArtifactIcon kind={resolveArtifactIconKind(artifact)} />
			<span className="min-w-0 flex-1 truncate text-xs">
				{name}
				{dir ? <span className="ml-1 text-[11px] text-text-tertiary">{dir}</span> : null}
			</span>
			<span
				className={cn(
					"shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
					artifact.status === "new"
						? "bg-status-green/15 text-status-green"
						: "bg-status-blue/15 text-status-blue",
				)}
			>
				{artifact.status === "new" ? "新" : "改"}
			</span>
		</button>
	);
}

/**
 * Read-only "Artifacts / 产物" panel: a grouped list of result files a task wrote
 * into its worktree (left) plus a live read-only viewer for the selection
 * (right). It owns only the selected relative path — content is fetched on open
 * and nothing is cached, so the references are weak by design.
 */
export function ArtifactsPanel({
	taskId,
	workspaceId,
	baseRef,
	artifacts,
	isLoading,
}: {
	taskId: string;
	workspaceId: string | null;
	baseRef: string | null;
	artifacts: RuntimeArtifact[] | null;
	isLoading: boolean;
}): React.ReactElement {
	const groups = useMemo(() => groupArtifactsByType(artifacts ?? []), [artifacts]);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	const availablePaths = useMemo(() => (artifacts ?? []).map((artifact) => artifact.path), [artifacts]);

	// Keep a valid selection: default to the first artifact, and recover if the
	// selected one disappears (renamed/deleted between polls).
	useEffect(() => {
		if (selectedPath && availablePaths.includes(selectedPath)) {
			return;
		}
		setSelectedPath(availablePaths[0] ?? null);
	}, [availablePaths, selectedPath]);

	const {
		content,
		isLoading: isContentLoading,
		isError,
	} = useRuntimeArtifactContent(taskId, workspaceId, baseRef, selectedPath);

	const isEmpty = artifacts !== null && artifacts.length === 0;

	if (isLoading && artifacts === null) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center bg-surface-0 text-text-tertiary">
				<Sparkles size={32} className="animate-pulse" />
			</div>
		);
	}

	if (isEmpty) {
		return (
			<div className="kb-empty-state-center flex min-h-0 flex-1 bg-surface-0">
				<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
					<Sparkles size={40} />
					<h3 className="font-semibold text-text-secondary">暂无产物</h3>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 min-w-0 flex-1 bg-surface-0">
			<div className="flex w-[44%] min-w-[200px] max-w-[420px] flex-col overflow-y-auto border-r border-divider px-2 py-2">
				{groups.map((group) => (
					<div key={group.type} className="mb-2">
						<div className="px-2 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
							{group.label}
						</div>
						{group.artifacts.map((artifact) => (
							<ArtifactRow
								key={artifact.path}
								artifact={artifact}
								isSelected={artifact.path === selectedPath}
								onSelect={() => setSelectedPath(artifact.path)}
							/>
						))}
					</div>
				))}
			</div>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<ArtifactViewer content={content} isLoading={isContentLoading} isError={isError} />
			</div>
		</div>
	);
}
