// Dismissible usage tips shown at the top of the home chat panel when the
// active home-thread agent is a CLI/terminal agent (anything other than pi).
// Moved out of ProjectNavigationPanel when the chat became its own dockable
// panel; the dismissed flag still persists under the same localStorage key.
import { Lightbulb, X } from "lucide-react";
import { useCallback, useState } from "react";

import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";

const TERMINAL_AGENT_HINTS: readonly { label: string; hint: string }[] = [
	{ label: "Create tasks", hint: "Ask your agent to add tasks, link them, and start working" },
	{ label: "Break down work", hint: "Ask to decompose a complex feature into linked subtasks" },
	{ label: "Import issues", hint: "Pull issues into task cards via GitHub CLI or Linear MCP" },
];

export function TerminalAgentHints(): React.ReactElement {
	const [isDismissed, setIsDismissed] = useState(
		() => readLocalStorageItem(LocalStorageKey.AgentTipsDismissed) === "true",
	);

	const dismiss = useCallback(() => {
		setIsDismissed(true);
		writeLocalStorageItem(LocalStorageKey.AgentTipsDismissed, "true");
	}, []);

	const restore = useCallback(() => {
		setIsDismissed(false);
		removeLocalStorageItem(LocalStorageKey.AgentTipsDismissed);
	}, []);

	if (isDismissed) {
		return (
			<div className="shrink-0">
				<button
					type="button"
					onClick={restore}
					className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] text-text-tertiary hover:text-text-secondary"
				>
					<Lightbulb size={11} />
					Show tips
				</button>
			</div>
		);
	}
	return (
		<div className="shrink-0 rounded-md border border-border bg-surface-2/60 px-3 py-2">
			<div className="mb-1.5 flex items-center justify-between">
				<span className="flex items-center gap-1 text-[11px] font-medium text-status-gold">
					<Lightbulb size={11} />
					Tips
				</span>
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss tips"
					className="cursor-pointer border-none bg-transparent p-0 text-text-tertiary hover:text-text-secondary"
				>
					<X size={12} />
				</button>
			</div>
			<ul className="m-0 list-none space-y-1 pl-0">
				{TERMINAL_AGENT_HINTS.map((item) => (
					<li key={item.label} className="flex items-start gap-1.5 text-[11px] text-text-primary">
						<span className="mt-[5px] block h-1 w-1 shrink-0 rounded-full bg-text-tertiary" />
						<span>
							<span className="font-medium">{item.label}.</span> {item.hint}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
