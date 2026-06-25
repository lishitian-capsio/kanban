// Per-agent executable-path override editor, shown in Settings → General → Agent.
//
// An absolute path Kanban uses for both detection and launch instead of
// discovering the agent's binary on $PATH (fixes the daemon case where $PATH
// omits user-local install dirs). pi is launched in-process, so this editor is
// rendered only for external CLI agents. Each agent gets its own collapsible
// instance, so the draft/saving/result state is naturally isolated per agent —
// the data layer is unchanged (still the `setAgentExecutablePath` mutation; the
// value stays on `AgentProviderSet` on disk).
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { setAgentExecutablePath } from "@/runtime/runtime-config-query";
import type { RuntimeAgentExecutablePathResponse, RuntimeAgentId } from "@/runtime/types";

export function AgentExecutablePathSetting({
	agentId,
	workspaceId,
	persistedExecutablePath,
	installed,
	disabled,
	onSaved,
}: {
	agentId: RuntimeAgentId;
	workspaceId: string | null;
	persistedExecutablePath: string;
	/** The agent's current install status, used as the "Detected" fallback before a save. */
	installed: boolean | null;
	disabled: boolean;
	/** Invoked after a successful save so the parent can reload provider sets + refresh config. */
	onSaved: () => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState(persistedExecutablePath);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<RuntimeAgentExecutablePathResponse | null>(null);

	// Reset the draft (and clear the last save feedback) whenever the persisted
	// override changes underneath us (e.g. another save, or a reload).
	useEffect(() => {
		setDraft(persistedExecutablePath);
		setResult(null);
	}, [persistedExecutablePath]);

	const dirty = draft.trim() !== persistedExecutablePath.trim();
	const hasOverride = persistedExecutablePath.trim().length > 0;

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			const res = await setAgentExecutablePath(workspaceId, {
				agentId,
				executablePath: draft.trim(),
			});
			setResult(res);
			onSaved();
		} finally {
			setSaving(false);
		}
	}, [agentId, draft, onSaved, workspaceId]);

	const inputId = `agent-executable-path-${agentId}`;

	return (
		<RadixCollapsible.Root open={open} onOpenChange={setOpen} className="ml-6 mt-0.5">
			<RadixCollapsible.Trigger
				className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-text-tertiary hover:text-text-secondary"
				disabled={disabled}
			>
				<ChevronRight size={12} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
				<span className="shrink-0">Executable path</span>
				<span
					className={cn("min-w-0 truncate font-mono", hasOverride ? "text-text-secondary" : "text-text-tertiary")}
				>
					{hasOverride ? persistedExecutablePath : "Auto-detect on $PATH"}
				</span>
			</RadixCollapsible.Trigger>
			<RadixCollapsible.Content>
				<div className="mt-1.5 rounded-md border border-border bg-surface-1 px-3 py-2.5">
					<div className="flex items-center gap-2">
						<input
							id={inputId}
							type="text"
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && dirty && !saving) {
									void handleSave();
								}
							}}
							placeholder={`Auto-detect on $PATH (e.g. /home/you/.local/bin/${agentId})`}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							disabled={disabled}
							className="h-8 flex-1 rounded-md border border-border bg-surface-2 px-2.5 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
						/>
						<Button size="sm" onClick={() => void handleSave()} disabled={disabled || !dirty || saving}>
							{saving ? "Saving…" : "Save"}
						</Button>
					</div>
					{!dirty && hasOverride ? (
						(result?.available ?? installed) ? (
							<p className="text-status-green text-[11px] mt-1.5 m-0">
								Detected — Kanban will launch this path.
							</p>
						) : (
							<p className="text-status-red text-[11px] mt-1.5 m-0">Not found or not executable at this path.</p>
						)
					) : null}
					<p className="text-text-tertiary text-[11px] mt-1.5 m-0 leading-relaxed">
						Leave blank to discover <code className="text-text-secondary">{agentId}</code> on{" "}
						<code className="text-text-secondary">$PATH</code>. Set an absolute path when Kanban can&apos;t find
						the CLI — e.g. running as a service whose PATH omits user-local install dirs. Note: a wrapper with a{" "}
						<code className="text-text-secondary">#!/usr/bin/env node</code> shebang still needs{" "}
						<code className="text-text-secondary">node</code> on PATH to run, so launch can still fail even once
						the path is pinned.
					</p>
				</div>
			</RadixCollapsible.Content>
		</RadixCollapsible.Root>
	);
}
