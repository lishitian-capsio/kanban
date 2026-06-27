// Microphone button for the chat composer (push-to-talk voice input).
//
// Single integration point for voice input: it lives in `KanbanChatComposer`, so both
// the home sidebar chat and the task chat panel get it for free. Click to start
// recording, click again (or the stop control) to finish — the clip is transcribed and
// the text handed to `onTranscript`, which fills the draft (never auto-sends).
//
// Renders nothing when the browser can't record (no MediaRecorder / insecure context),
// so the composer degrades cleanly on plain-HTTP LAN access. When recording is supported
// but no STT endpoint is configured, the button stays visible but points the user to
// Settings instead of failing silently.

import { Mic, MicOff, Square } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { formatRecordingElapsed } from "@/hooks/voice-input-state";
import { fetchSttStatus } from "@/runtime/runtime-config-query";
import { createLogger } from "@/utils/logger";

const log = createLogger("voice-input-button");

export interface VoiceInputButtonProps {
	workspaceId: string | null;
	/** Receives the recognized transcript; the composer appends it to the draft. */
	onTranscript: (text: string) => void;
	/** Optional language override (ISO-639-1); falls back to the configured default. */
	language?: string;
	disabled?: boolean;
}

export function VoiceInputButton({
	workspaceId,
	onTranscript,
	language,
	disabled = false,
}: VoiceInputButtonProps): ReactElement | null {
	const { status, elapsedMs, isSupported, toggle } = useVoiceInput({ workspaceId, language, onTranscript });
	// null = unknown (still checking); the button stays optimistically enabled until known.
	const [configured, setConfigured] = useState<boolean | null>(null);
	const configuredRef = useRef<boolean | null>(null);
	configuredRef.current = configured;

	const refreshConfigured = useCallback(async (): Promise<boolean> => {
		try {
			const next = await fetchSttStatus(workspaceId);
			setConfigured(next.configured);
			return next.configured;
		} catch (error) {
			log.warn("failed to read STT status", { error });
			return configuredRef.current ?? false;
		}
	}, [workspaceId]);

	useEffect(() => {
		if (!isSupported) {
			return;
		}
		void refreshConfigured();
	}, [isSupported, refreshConfigured]);

	const handleClick = useCallback(() => {
		// Self-heal: if we believe it's unconfigured, re-check before refusing — the user
		// may have just set it up in Settings without remounting the composer.
		if (configuredRef.current === false) {
			void (async () => {
				const nowConfigured = await refreshConfigured();
				if (nowConfigured) {
					toggle();
				} else {
					showAppToast({
						intent: "warning",
						icon: "warning-sign",
						message: "Speech-to-text isn't set up. Configure it in Settings → Project.",
						timeout: 6000,
					});
				}
			})();
			return;
		}
		toggle();
	}, [refreshConfigured, toggle]);

	if (!isSupported) {
		return null;
	}

	const isRecording = status === "recording";
	const isTranscribing = status === "transcribing" || status === "requesting";

	if (isRecording) {
		return (
			<Tooltip side="top" content="Stop recording">
				<button
					type="button"
					onClick={handleClick}
					aria-label="Stop recording"
					className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-status-red/40 bg-status-red/10 pl-2 pr-2.5 text-status-red hover:bg-status-red/20"
				>
					<span className="h-2 w-2 animate-pulse rounded-full bg-status-red" />
					<span className="font-mono text-[11px] tabular-nums">{formatRecordingElapsed(elapsedMs)}</span>
					<Square size={12} className="fill-current" />
				</button>
			</Tooltip>
		);
	}

	const tooltip = configured === false ? "Set up voice input in Settings" : "Record voice input";

	return (
		<Tooltip side="top" content={tooltip}>
			<Button
				variant="default"
				size="sm"
				className={cn(
					"h-7 w-7 rounded-full border-border-bright bg-surface-4 p-0 text-text-primary hover:bg-surface-3",
					configured === false && "text-text-tertiary",
				)}
				aria-label="Record voice input"
				disabled={disabled || isTranscribing}
				onClick={handleClick}
				icon={
					isTranscribing ? <Spinner size={12} /> : configured === false ? <MicOff size={14} /> : <Mic size={14} />
				}
			/>
		</Tooltip>
	);
}
