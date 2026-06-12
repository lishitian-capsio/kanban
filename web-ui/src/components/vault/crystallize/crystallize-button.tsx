import { Sparkles } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { Tooltip } from "@/components/ui/tooltip";
import { getVaultTypeView } from "../data/vault-type-registry";
import { CrystallizeDialog, type CrystallizeSubmit } from "./crystallize-dialog";
import { useCrystallize } from "./use-crystallize";

interface CrystallizeButtonProps {
	workspaceId: string | null;
	/** The active home thread's session id, or null when no session has started. */
	sessionId: string | null;
}

/**
 * Home-sidebar entry that distills the active chat thread into a vault document
 * ("把这段对话提炼成需求/决策/纪要落进 vault"). Disabled until a session exists.
 */
export function CrystallizeButton({ workspaceId, sessionId }: CrystallizeButtonProps): React.ReactElement {
	const [open, setOpen] = useState(false);
	const { crystallize, isCrystallizing } = useCrystallize(workspaceId);

	const disabled = !workspaceId || !sessionId;

	function handleSubmit(input: CrystallizeSubmit): void {
		if (!sessionId) {
			return;
		}
		void (async () => {
			try {
				const document = await crystallize({ sessionId, ...input });
				if (document) {
					const typeLabel = getVaultTypeView(document.type)?.label ?? document.type;
					showAppToast(
						{
							intent: "success",
							icon: "tick",
							message: `Crystallized “${document.title}” into ${typeLabel}.`,
							timeout: 4000,
						},
						"crystallize-success",
					);
					setOpen(false);
				}
			} catch (error) {
				notifyError(error instanceof Error ? error.message : "Could not crystallize this conversation.", {
					key: "crystallize-error",
				});
			}
		})();
	}

	return (
		<>
			<Tooltip content={disabled ? "Start a chat to crystallize it" : "Crystallize this chat into a vault document"}>
				<button
					type="button"
					aria-label="Crystallize chat to vault"
					disabled={disabled}
					onClick={() => setOpen(true)}
					className="flex shrink-0 items-center rounded-sm p-1.5 text-text-secondary outline-none hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
				>
					<Sparkles size={14} />
				</button>
			</Tooltip>
			<CrystallizeDialog open={open} isSaving={isCrystallizing} onOpenChange={setOpen} onSubmit={handleSubmit} />
		</>
	);
}
