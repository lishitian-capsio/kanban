import { GitBranch } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useBoardSync } from "@/hooks/use-board-sync";

/**
 * The "Board data branch" control in Settings → Project. Reads the authoritative
 * branch from `.kanban/board-ref` (via the board sync status) and renames it through
 * the non-destructive migration: the new branch is created from the current tip and
 * the old one is archived as a rollback anchor, so the board never goes empty.
 * Self-contained (owns its own {@link useBoardSync}), mirroring the vault settings
 * controls — only meaningful once board-branch decoupling is active.
 */
export function BoardBranchSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { status, isRenaming, renameBranch } = useBoardSync(workspaceId);
	const [draft, setDraft] = useState<string | null>(null);

	const currentBranch = status?.branch ?? "";
	const value = draft ?? currentBranch;
	const trimmed = value.trim();
	const isDirty = trimmed.length > 0 && trimmed !== currentBranch;

	const handleSave = async () => {
		if (!isDirty || isRenaming) {
			return;
		}
		const result = await renameBranch(trimmed);
		if (result.ok) {
			setDraft(null);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: `Board data branch renamed to ${trimmed}.${
					result.archivedTag ? ` The old branch was archived as ${result.archivedTag}.` : ""
				}`,
				timeout: 6000,
			});
		}
	};

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				Board data branch
			</h6>
			{status === null ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : status.decoupled ? (
				<>
					<div className="flex items-center gap-2">
						<span className="text-text-tertiary">
							<GitBranch size={14} />
						</span>
						<input
							value={value}
							onChange={(event) => setDraft(event.target.value)}
							spellCheck={false}
							disabled={isRenaming}
							className="h-8 flex-1 rounded-md border border-border bg-surface-2 px-2 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
							placeholder="kanban/board"
						/>
						<Button variant="primary" size="sm" onClick={handleSave} disabled={!isDirty || isRenaming}>
							{isRenaming ? (
								<>
									<Spinner size={12} />
									Renaming…
								</>
							) : (
								"Rename"
							)}
						</Button>
					</div>
					<p className="text-text-secondary text-[13px] mt-2 mb-0">
						The board's columns, cards, dependencies, and vault live on a dedicated git branch. Renaming creates
						the new branch from the current tip and archives the old one (as{" "}
						<span className="font-mono">kanban/board-archive/…</span>) so the change is reversible.
					</p>
				</>
			) : (
				<p className="text-text-secondary text-[13px] m-0">
					Board data is currently committed on your code branch. Once it is moved to a dedicated branch, you can
					rename that branch here.
				</p>
			)}
		</div>
	);
}
