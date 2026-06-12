import * as Popover from "@radix-ui/react-popover";
import { Save, Trash2 } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { VaultViewStateResult } from "./use-vault-view-state";

/** Save / Save-as / Delete controls for the active saved view. */
export function SaveViewControls({ state }: { state: VaultViewStateResult }): React.ReactElement {
	const { selectedView, isDirty, isMutating, saveCurrent, saveAsNew, deleteCurrent } = state;
	const [saveAsOpen, setSaveAsOpen] = useState(false);
	const [name, setName] = useState("");

	async function handleSaveAs(): Promise<void> {
		const trimmed = name.trim();
		if (!trimmed) {
			return;
		}
		await saveAsNew(trimmed);
		setName("");
		setSaveAsOpen(false);
	}

	return (
		<div className="flex items-center gap-1.5">
			{selectedView && isDirty ? (
				<Button
					size="sm"
					variant="primary"
					icon={<Save size={13} />}
					disabled={isMutating}
					onClick={() => void saveCurrent()}
				>
					Save
				</Button>
			) : null}

			<Popover.Root open={saveAsOpen} onOpenChange={setSaveAsOpen}>
				<Popover.Trigger asChild>
					<Button size="sm" variant="default">
						Save as view
					</Button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="end"
						sideOffset={6}
						className="z-50 w-64 rounded-lg border border-border bg-surface-1 p-3 shadow-xl"
					>
						<label className="mb-1.5 block text-[12px] font-medium text-text-secondary" htmlFor="vault-view-name">
							View name
						</label>
						<input
							id="vault-view-name"
							ref={(node) => node?.focus()}
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									void handleSaveAs();
								}
							}}
							placeholder="e.g. High priority"
							className="mb-2 h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2 text-[13px] text-text-primary focus:border-border-focus focus:outline-none"
						/>
						<Button
							size="sm"
							variant="primary"
							fill
							disabled={!name.trim() || isMutating}
							onClick={() => void handleSaveAs()}
						>
							Create view
						</Button>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>

			{selectedView ? (
				<Button
					size="sm"
					variant="ghost"
					icon={<Trash2 size={13} />}
					aria-label="Delete view"
					disabled={isMutating}
					onClick={() => void deleteCurrent()}
				/>
			) : null}
		</div>
	);
}
