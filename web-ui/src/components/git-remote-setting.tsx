import { Globe } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGitRemoteEditor } from "@/hooks/use-git-remote-editor";

/** Basic git remote URL shape check, kept in sync with the backend contract refinement. */
function isValidGitRemoteUrl(value: string): boolean {
	const trimmed = value.trim();
	return trimmed !== "" && /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+|[^@\s]+@[^:\s]+:\S+|[./~]\S*)$/.test(trimmed);
}

/**
 * The "Git remote (origin)" control in Settings → Project. Reads and edits the workspace
 * repo's real `origin` remote URL via `workspace.getGitRemote` / `setGitRemote`. Kanban may
 * have `git init`-ed the repo locally with no remote when the project was added; this lets the
 * user point it at a real upstream later, after which the existing board-sync push path can
 * reach it. Self-contained (owns its own {@link useGitRemoteEditor}), mirroring
 * {@link GitIdentitySetting}. Authentication is never handled here — credentials stay with the
 * system git credential helper / SSH agent.
 */
export function GitRemoteSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { url, isLoading, isSaving, save } = useGitRemoteEditor(workspaceId);
	const [draft, setDraft] = useState<string | null>(null);

	const current = url ?? "";
	const value = draft ?? current;
	const trimmed = value.trim();

	const hasValue = trimmed.length > 0;
	const urlValid = isValidGitRemoteUrl(value);
	const isDirty = value !== current;
	const canSave = isDirty && urlValid && !isSaving;

	const handleSave = async () => {
		if (!canSave) {
			return;
		}
		const result = await save(trimmed);
		if (result.ok) {
			setDraft(null);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Git remote updated for this repository.",
				timeout: 4000,
			});
			return;
		}
		showAppToast({
			intent: "danger",
			icon: "error",
			message: result.error ?? "Could not update the git remote.",
			timeout: 6000,
		});
	};

	const inputClass =
		"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<Globe size={13} />
				Git remote (origin)
			</h6>
			{isLoading && url === null && draft === null ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : (
				<>
					<label htmlFor="git-remote-url" className="block text-[12px] text-text-secondary mb-1">
						Remote URL
					</label>
					<input
						id="git-remote-url"
						value={value}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="https://github.com/owner/repo.git"
						spellCheck={false}
						autoComplete="off"
						disabled={isSaving}
						className={inputClass}
					/>
					{hasValue && !urlValid ? (
						<p className="text-status-red text-[12px] mt-1.5 mb-0">Enter a valid git remote URL.</p>
					) : current === "" ? (
						<p className="text-text-secondary text-[12px] mt-1.5 mb-0">
							No remote is configured yet — add one so this repository can push.
						</p>
					) : null}
					<div className="flex items-center justify-between gap-2 mt-3">
						<p className="text-text-secondary text-[13px] m-0">
							Sets the real <span className="font-mono">origin</span> remote for this repository. Authentication
							uses your system git credentials (credential helper / SSH agent) — no keys are stored here.
						</p>
						<Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave}>
							{isSaving ? (
								<>
									<Spinner size={12} />
									Saving…
								</>
							) : (
								"Save remote"
							)}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
