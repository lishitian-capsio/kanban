import { useCallback, useEffect, useRef, useState } from "react";

import {
	describeSpeechDictationError,
	describeSpeechDictationUnsupported,
	detectSpeechDictationSupport,
	type SpeechDictationUnsupportedReason,
} from "@/components/home-agent/native-speech-dictation-state";

export type NativeSpeechStatus = "idle" | "listening" | "error";

type NativeSpeechRecognitionErrorCode =
	| "aborted"
	| "audio-capture"
	| "bad-grammar"
	| "language-not-supported"
	| "network"
	| "no-speech"
	| "not-allowed"
	| "phrases-not-supported"
	| "service-not-allowed";

interface NativeSpeechRecognitionAlternative {
	readonly transcript: string;
	readonly confidence: number;
}

interface NativeSpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): NativeSpeechRecognitionAlternative;
}

interface NativeSpeechRecognitionResultList {
	readonly length: number;
	item(index: number): NativeSpeechRecognitionResult;
}

interface NativeSpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: NativeSpeechRecognitionResultList;
}

interface NativeSpeechRecognitionErrorEvent extends Event {
	readonly error: NativeSpeechRecognitionErrorCode;
	readonly message: string;
}

interface NativeSpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onend: ((event: Event) => void) | null;
	onerror: ((event: NativeSpeechRecognitionErrorEvent) => void) | null;
	onresult: ((event: NativeSpeechRecognitionEvent) => void) | null;
	onstart: ((event: Event) => void) | null;
	abort: () => void;
	start: () => void;
	stop: () => void;
}

interface NativeSpeechRecognitionConstructor {
	new (): NativeSpeechRecognition;
}

interface SpeechRecognitionWindow extends Window {
	SpeechRecognition?: NativeSpeechRecognitionConstructor;
	webkitSpeechRecognition?: NativeSpeechRecognitionConstructor;
}

export interface UseNativeSpeechDictationResult {
	isSupported: boolean;
	/** Why dictation is unavailable (insecure context vs. unsupported browser); null when supported. */
	unsupportedReason: SpeechDictationUnsupportedReason | null;
	status: NativeSpeechStatus;
	message: string | null;
	interimTranscript: string;
	start: () => void;
	stop: () => void;
	reset: () => void;
}

function getNativeSpeechRecognitionConstructor(): NativeSpeechRecognitionConstructor | null {
	if (typeof window === "undefined") {
		return null;
	}
	const speechWindow = window as SpeechRecognitionWindow;
	return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function useNativeSpeechDictation(onTranscript: (transcript: string) => void): UseNativeSpeechDictationResult {
	const recognitionRef = useRef<NativeSpeechRecognition | null>(null);
	const onTranscriptRef = useRef(onTranscript);
	onTranscriptRef.current = onTranscript;

	const [support] = useState(() =>
		detectSpeechDictationSupport(typeof window === "undefined" ? null : (window as SpeechRecognitionWindow)),
	);
	const isSupported = support.supported;
	const unsupportedReason = support.supported ? null : support.reason;
	const [status, setStatus] = useState<NativeSpeechStatus>("idle");
	const [message, setMessage] = useState<string | null>(null);
	const [interimTranscript, setInterimTranscript] = useState("");

	const abortRecognition = useCallback(() => {
		const recognition = recognitionRef.current;
		if (recognition) {
			recognition.onend = null;
			recognition.onerror = null;
			recognition.onresult = null;
			recognition.onstart = null;
			recognition.abort();
		}
		recognitionRef.current = null;
	}, []);

	const stop = useCallback(() => {
		recognitionRef.current?.stop();
	}, []);

	const reset = useCallback(() => {
		abortRecognition();
		setStatus("idle");
		setMessage(null);
		setInterimTranscript("");
	}, [abortRecognition]);

	useEffect(() => abortRecognition, [abortRecognition]);

	const start = useCallback(() => {
		// Re-check support at click time: an insecure (plain-HTTP LAN) context exposes
		// the constructor but can never capture audio, so surface the actionable
		// HTTPS/localhost guidance instead of letting start() emit a raw `not-allowed`.
		const currentSupport = detectSpeechDictationSupport(
			typeof window === "undefined" ? null : (window as SpeechRecognitionWindow),
		);
		const Recognition = getNativeSpeechRecognitionConstructor();
		if (!currentSupport.supported || !Recognition) {
			setStatus("error");
			setMessage(
				describeSpeechDictationUnsupported(
					currentSupport.supported ? "unsupported-browser" : currentSupport.reason,
				),
			);
			return;
		}

		abortRecognition();
		const recognition = new Recognition();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";
		recognition.onstart = () => {
			setStatus("listening");
			setMessage("Listening...");
			setInterimTranscript("");
		};
		recognition.onresult = (event) => {
			let finalText = "";
			let interimText = "";
			for (let index = event.resultIndex; index < event.results.length; index += 1) {
				const result = event.results.item(index);
				const transcript = result.length > 0 ? result.item(0).transcript : "";
				if (result.isFinal) {
					finalText = `${finalText} ${transcript}`.trim();
				} else {
					interimText = `${interimText} ${transcript}`.trim();
				}
			}
			setInterimTranscript(interimText);
			if (finalText) {
				onTranscriptRef.current(finalText);
				setMessage("Added voice text.");
			}
		};
		recognition.onerror = (event) => {
			setStatus("error");
			setMessage(describeSpeechDictationError(event.error, event.message));
			setInterimTranscript("");
		};
		recognition.onend = () => {
			recognitionRef.current = null;
			setInterimTranscript("");
			setStatus((current) => (current === "listening" ? "idle" : current));
			setMessage((current) => (current === "Listening..." ? "Voice input stopped." : current));
		};

		try {
			recognitionRef.current = recognition;
			recognition.start();
		} catch (error) {
			recognitionRef.current = null;
			setInterimTranscript("");
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "Could not start voice input.");
		}
	}, [abortRecognition]);

	return { isSupported, unsupportedReason, status, message, interimTranscript, start, stop, reset };
}
