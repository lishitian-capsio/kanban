import { Plus, Upload, X } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useExtraPushRemotes } from "@/hooks/use-extra-push-remotes";
import type { RuntimeExtraPushRemote } from "@/runtime/types";

/** Basic git remote URL shape check, kept in sync with the backend contract refinement. */
function isValidGitRemoteUrl(value: string): boolean {
	const trimmed = value.trim();
	return trimmed !== "" && /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+|[^@\s]+@[^:\s]+:\S+|[./~]\S*)$/.test(trimmed);
}

function sameRemotes(left: RuntimeExtraPushRemote[], right: RuntimeExtraPushRemote[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((item, index) => item.name === right[index]?.name && item.url === right[index]?.url);
}

const inputClass =
	"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60";

/**
 * The "Extra push remotes" control in Settings → Project. Lets the user configure
 * additional git remotes (name + URL) that the repo code is mirror-pushed to after a
 * successful `git push` — e.g. mirroring one project to GitHub + Gitee. Reads/writes the
 * `extraPushRemotes` field of the workspace vault settings via {@link useExtraPushRemotes}.
 * A failed mirror push is reported in the sync output but never blocks the primary push.
 * Authentication is never handled here — mirror pushes reuse the same per-host git
 * credentials as `origin`.
 */
export function ExtraPushRemotesSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { remotes, isLoading, isSaving, save } = useExtraPushRemotes(workspaceId);
	const [draft, setDraft] = useState<RuntimeExtraPushRemote[] | null>(null);

	const current = remotes ?? [];
	const value = draft ?? current;

	const isDirty = !sameRemotes(value, current);
	const allValid = value.every((remote) => remote.name.trim() !== "" && isValidGitRemoteUrl(remote.url));
	const canSave = isDirty && allValid && !isSaving;

	const updateRow = (index: number, patch: Partial<RuntimeExtraPushRemote>) => {
		setDraft(value.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
	};

	const handleSave = async () => {
		if (!canSave) {
			return;
		}
		const normalized = value.map((remote) => ({ name: remote.name.trim(), url: remote.url.trim() }));
		const result = await save(normalized);
		if (result.ok) {
			setDraft(null);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Extra push remotes updated for this repository.",
				timeout: 4000,
			});
			return;
		}
		showAppToast({
			intent: "danger",
			icon: "error",
			message: result.error ?? "Could not update the extra push remotes.",
			timeout: 6000,
		});
	};

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<div className="flex items-center justify-between mb-2">
				<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0">
					<Upload size={13} />
					Extra push remotes
				</h6>
				<Button
					variant="ghost"
					size="sm"
					icon={<Plus size={14} />}
					onClick={() => setDraft([...value, { name: "", url: "" }])}
					disabled={isSaving}
				>
					Add
				</Button>
			</div>

			{isLoading && remotes === null && draft === null ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : (
				<>
					{value.map((remote, index) => {
						const urlInvalid = remote.url.trim() !== "" && !isValidGitRemoteUrl(remote.url);
						return (
							<div key={index} className="grid grid-cols-[10rem_1fr_auto] items-start gap-2 mb-2">
								<input
									aria-label={`Remote name ${index + 1}`}
									value={remote.name}
									onChange={(event) => updateRow(index, { name: event.target.value })}
									placeholder="gitee"
									spellCheck={false}
									autoComplete="off"
									disabled={isSaving}
									className={inputClass}
								/>
								<div>
									<input
										aria-label={`Remote URL ${index + 1}`}
										value={remote.url}
										onChange={(event) => updateRow(index, { url: event.target.value })}
										placeholder="https://gitee.com/owner/repo.git"
										spellCheck={false}
										autoComplete="off"
										disabled={isSaving}
										className={inputClass}
									/>
									{urlInvalid ? (
										<p className="text-status-red text-[12px] mt-1 mb-0">Enter a valid git remote URL.</p>
									) : null}
								</div>
								<Button
									variant="ghost"
									size="sm"
									icon={<X size={14} />}
									aria-label={`Remove remote ${remote.name || index + 1}`}
									onClick={() => setDraft(value.filter((_, itemIndex) => itemIndex !== index))}
									disabled={isSaving}
								/>
							</div>
						);
					})}
					{value.length === 0 ? (
						<p className="text-text-secondary text-[13px] m-0 mb-1">No extra remotes configured.</p>
					) : null}

					<div className="flex items-center justify-between gap-2 mt-3">
						<p className="text-text-secondary text-[13px] m-0">
							After a successful <span className="font-mono">push</span>, the current branch is also pushed to
							each remote above. A failed mirror push is reported but never blocks the primary push.
							Authentication reuses your per-host git credentials — no keys are stored here.
						</p>
						<Button variant="primary" size="sm" onClick={handleSave} disabled={!canSave}>
							{isSaving ? (
								<>
									<Spinner size={12} />
									Saving…
								</>
							) : (
								"Save remotes"
							)}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
