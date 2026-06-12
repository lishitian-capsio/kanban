import { Sparkles } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

import { getVaultTypeView } from "../data/vault-type-registry";
import { VaultSelect } from "../views/vault-property-controls";

// The crystallize targets the user can distill a conversation into (需求/决策/纪要).
const CRYSTALLIZE_TYPES = ["requirement", "decision", "note"] as const;

type Scope = "whole" | "lastN";

const DEFAULT_LAST_N = 10;

export interface CrystallizeSubmit {
	type: string;
	lastN?: number;
	title?: string;
}

interface CrystallizeDialogProps {
	open: boolean;
	isSaving: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (input: CrystallizeSubmit) => void;
}

function ScopeOption({
	active,
	label,
	description,
	onClick,
}: {
	active: boolean;
	label: string;
	description: string;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex flex-1 flex-col gap-0.5 rounded-md border px-3 py-2 text-left outline-none",
				active
					? "border-accent bg-accent/10 text-text-primary"
					: "border-border bg-surface-2 text-text-secondary hover:bg-surface-3",
			)}
		>
			<span className="text-[13px] font-medium">{label}</span>
			<span className="text-[11px] text-text-tertiary">{description}</span>
		</button>
	);
}

/**
 * Collects the target type and message span for crystallizing the active home-chat
 * thread into a vault document. MVP scope is "whole thread / last N" — per-message
 * range selection is a later task.
 */
export function CrystallizeDialog({
	open,
	isSaving,
	onOpenChange,
	onSubmit,
}: CrystallizeDialogProps): React.ReactElement {
	const [type, setType] = useState<string>(CRYSTALLIZE_TYPES[0]);
	const [scope, setScope] = useState<Scope>("whole");
	const [lastN, setLastN] = useState<number>(DEFAULT_LAST_N);
	const [title, setTitle] = useState("");

	useEffect(() => {
		if (open) {
			setType(CRYSTALLIZE_TYPES[0]);
			setScope("whole");
			setLastN(DEFAULT_LAST_N);
			setTitle("");
		}
	}, [open]);

	const typeOptions = CRYSTALLIZE_TYPES.map((value) => ({
		value,
		label: getVaultTypeView(value)?.label ?? value,
	}));

	const effectiveLastN = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : DEFAULT_LAST_N;
	const canSave = !isSaving;

	function submit(): void {
		if (!canSave) {
			return;
		}
		onSubmit({
			type,
			lastN: scope === "lastN" ? effectiveLastN : undefined,
			title: title.trim() || undefined,
		});
	}

	return (
		<Dialog
			open={open}
			contentAriaDescribedBy={undefined}
			onOpenChange={(next) => {
				if (!isSaving) {
					onOpenChange(next);
				}
			}}
		>
			<DialogHeader title="Crystallize to vault" icon={<Sparkles size={16} />} />
			<DialogBody>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">Document type</span>
						<VaultSelect
							value={type}
							options={typeOptions}
							onValueChange={setType}
							ariaLabel="Document type"
							className="w-full"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">From this conversation</span>
						<div className="flex gap-2">
							<ScopeOption
								active={scope === "whole"}
								label="Whole thread"
								description="Every message in this chat"
								onClick={() => setScope("whole")}
							/>
							<ScopeOption
								active={scope === "lastN"}
								label="Last messages"
								description="Only the most recent turns"
								onClick={() => setScope("lastN")}
							/>
						</div>
						{scope === "lastN" ? (
							<div className="flex items-center gap-2 pt-1">
								<input
									type="number"
									min={1}
									value={lastN}
									onChange={(event) => setLastN(event.target.valueAsNumber)}
									className="h-8 w-20 rounded-md border border-border-bright bg-surface-2 px-2.5 text-[13px] text-text-primary outline-none focus:border-border-focus"
								/>
								<span className="text-[12px] text-text-tertiary">most recent messages</span>
							</div>
						) : null}
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-[12px] font-medium text-text-secondary">
							Title <span className="text-text-tertiary">(optional)</span>
						</span>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									submit();
								}
							}}
							placeholder="Derived from the conversation if left blank"
							disabled={isSaving}
							className="h-9 w-full rounded-md border border-border bg-surface-2 px-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
						/>
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button onClick={() => onOpenChange(false)} disabled={isSaving}>
					Cancel
				</Button>
				<Button variant="primary" onClick={submit} disabled={!canSave}>
					{isSaving ? (
						<>
							<Spinner size={12} />
							Crystallizing…
						</>
					) : (
						"Crystallize"
					)}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
