import { AlertCircle, Check, MessageSquarePlus, Mic, MicOff, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { AgentAvatar } from "@/components/home-agent/agent-icon";
import {
	appendDictationText,
	describeSpeechDictationUnsupported,
	describeSpeechDictationUnsupportedTooltip,
} from "@/components/home-agent/native-speech-dictation-state";
import { useNativeSpeechDictation } from "@/components/home-agent/use-native-speech-dictation";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { isNativeAgentSelected } from "@/runtime/native-agent";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

interface HomeThreadCreateDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: RuntimeAgentDefinition[];
	defaultAgentId: RuntimeAgentId;
	onCreate: (input: { description: string; agentId: RuntimeAgentId }) => void | Promise<unknown>;
}

export function HomeThreadCreateDialog({
	open,
	onOpenChange,
	agents,
	defaultAgentId,
	onCreate,
}: HomeThreadCreateDialogProps): React.ReactElement {
	// The native/main agent (pi) is always running and singular, so threads can
	// only be created for the additional CLI agents.
	const selectableAgents = useMemo(() => agents.filter((agent) => !isNativeAgentSelected(agent.id)), [agents]);

	// Fall back to the first selectable agent when the incoming default is the
	// native agent (or otherwise not selectable), so the form never opens with a
	// hidden or empty selection.
	const resolvedDefaultAgentId = useMemo<RuntimeAgentId | null>(() => {
		if (selectableAgents.some((agent) => agent.id === defaultAgentId)) {
			return defaultAgentId;
		}
		return selectableAgents[0]?.id ?? null;
	}, [selectableAgents, defaultAgentId]);

	const descriptionId = useId();
	const descriptionHelpId = useId();
	const descriptionStatusId = useId();
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const [description, setDescription] = useState("");
	const [agentId, setAgentId] = useState<RuntimeAgentId | null>(resolvedDefaultAgentId);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Reset the form each time the dialog opens.
	useEffect(() => {
		if (open) {
			setDescription("");
			setAgentId(resolvedDefaultAgentId);
			setIsSubmitting(false);
		}
	}, [open, resolvedDefaultAgentId]);

	const focusDescriptionEnd = useCallback(() => {
		window.requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) {
				return;
			}
			textarea.focus();
			const cursor = textarea.value.length;
			textarea.setSelectionRange(cursor, cursor);
		});
	}, []);

	const handleDictationTranscript = useCallback(
		(transcript: string) => {
			setDescription((current) => appendDictationText(current, transcript));
			focusDescriptionEnd();
		},
		[focusDescriptionEnd],
	);

	const {
		isSupported: isSpeechSupported,
		unsupportedReason: speechUnsupportedReason,
		status: speechStatus,
		message: speechMessage,
		interimTranscript,
		start: startListening,
		stop: stopListening,
		reset: resetVoiceInput,
	} = useNativeSpeechDictation(handleDictationTranscript);

	useEffect(() => {
		if (open) {
			return;
		}
		resetVoiceInput();
	}, [open, resetVoiceInput]);

	const trimmedDescription = description.trim();
	const canSubmit = trimmedDescription.length > 0 && !isSubmitting && agentId !== null;
	const descriptionStateText = useMemo(() => {
		if (speechUnsupportedReason) {
			return describeSpeechDictationUnsupported(speechUnsupportedReason);
		}
		if (speechMessage) {
			return speechMessage;
		}
		return "The thread's agent works from this opening prompt and names the thread itself.";
	}, [speechUnsupportedReason, speechMessage]);

	const handleSubmit = async () => {
		if (!canSubmit || agentId === null) {
			return;
		}
		setIsSubmitting(true);
		try {
			await onCreate({ description: trimmedDescription, agentId });
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentClassName="max-w-md">
			<DialogHeader title="New chat thread" icon={<MessageSquarePlus size={16} />} />
			<DialogBody className="flex flex-col gap-5">
				<div className="flex flex-col gap-2">
					<label htmlFor={descriptionId} className="text-[12px] font-medium text-text-secondary">
						Opening prompt
					</label>
					<div
						className={cn(
							"rounded-lg border bg-surface-2 transition-colors focus-within:border-border-focus",
							speechStatus === "error" ? "border-status-red/50" : "border-border-bright",
							speechStatus === "listening" && "border-accent bg-surface-3/40",
						)}
					>
						<textarea
							ref={textareaRef}
							id={descriptionId}
							value={description}
							autoFocus
							rows={5}
							aria-describedby={`${descriptionHelpId} ${descriptionStatusId}`}
							aria-required="true"
							placeholder="Describe the work, question, or next step for this thread..."
							onChange={(event) => {
								setDescription(event.target.value);
							}}
							onKeyDown={(event) => {
								// Enter inserts a newline; ⌘/Ctrl+Enter submits.
								if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
									event.preventDefault();
									void handleSubmit();
									return;
								}
								if (event.key === "Escape" && speechStatus === "listening") {
									event.preventDefault();
									stopListening();
								}
							}}
							className="min-h-[132px] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-tertiary focus:outline-none"
						/>
						{interimTranscript ? (
							<div className="mx-3 mb-2 rounded-md border border-border bg-surface-1 px-2 py-1.5 text-[12px] leading-relaxed text-text-secondary">
								<span className="text-text-tertiary">Listening: </span>
								{interimTranscript}
							</div>
						) : null}
						<div className="flex min-w-0 items-center gap-2 border-t border-border px-2.5 py-2">
							<p id={descriptionStatusId} className="min-w-0 flex-1 text-[11px] leading-4 text-text-tertiary">
								{speechStatus === "error" ? (
									<span className="inline-flex min-w-0 items-center gap-1 text-status-red">
										<AlertCircle size={12} className="shrink-0" />
										<span className="min-w-0 break-words">{descriptionStateText}</span>
									</span>
								) : (
									descriptionStateText
								)}
							</p>
							<Tooltip
								side="top"
								content={
									speechUnsupportedReason
										? describeSpeechDictationUnsupportedTooltip(speechUnsupportedReason)
										: speechStatus === "listening"
											? "Stop voice input"
											: "Dictate the opening prompt"
								}
							>
								<button
									type="button"
									aria-label={speechStatus === "listening" ? "Stop voice input" : "Start voice input"}
									aria-pressed={speechStatus === "listening"}
									disabled={!isSpeechSupported || isSubmitting}
									onClick={() => {
										if (speechStatus === "listening") {
											stopListening();
										} else {
											startListening();
										}
									}}
									className={cn(
										"inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors",
										"focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
										"disabled:pointer-events-none disabled:cursor-default disabled:opacity-45",
										speechStatus === "listening"
											? "border-status-red/40 bg-status-red/10 text-status-red hover:bg-status-red/20"
											: "border-border-bright bg-surface-3 text-text-primary hover:bg-surface-4",
									)}
								>
									{speechStatus === "listening" ? (
										<>
											<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-red" />
											<Square size={12} className="fill-current" />
											Stop
										</>
									) : isSpeechSupported ? (
										<>
											<Mic size={14} />
											Voice
										</>
									) : (
										<>
											<MicOff size={14} />
											Voice
										</>
									)}
								</button>
							</Tooltip>
						</div>
					</div>
					<p id={descriptionHelpId} className="text-[11px] text-text-tertiary">
						Use a clear first instruction. Long prompts are preserved and can span multiple lines.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<span className="text-[12px] font-medium text-text-secondary">Agent</span>
					{selectableAgents.length === 0 ? (
						<p className="rounded-md border border-dashed border-border bg-surface-2 px-2.5 py-2 text-[12px] text-text-tertiary">
							No additional agents are available.
						</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{selectableAgents.map((agent) => {
								const selected = agent.id === agentId;
								return (
									<button
										key={agent.id}
										type="button"
										aria-pressed={selected}
										onClick={() => setAgentId(agent.id)}
										className={cn(
											"inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
											selected
												? "border-accent bg-accent/10 text-text-primary"
												: "border-border bg-surface-2 text-text-secondary hover:border-border-bright hover:bg-surface-3 hover:text-text-primary",
										)}
									>
										{/* Agent-type identity (⑥): the same boxed avatar treatment, leading the label. */}
										<AgentAvatar agents={agents} agentId={agent.id} size="sm" />
										{agent.label}
										{selected ? <Check size={13} className="text-accent" /> : null}
									</button>
								);
							})}
						</div>
					)}
				</div>
			</DialogBody>
			<DialogFooter>
				<span className="mr-auto hidden items-center gap-1 text-[11px] text-text-tertiary sm:flex">
					<Kbd>{isMacPlatform ? "⌘" : "Ctrl"}</Kbd>
					<Kbd>↵</Kbd>
					to create
				</span>
				<Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => void handleSubmit()}>
					Create
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
