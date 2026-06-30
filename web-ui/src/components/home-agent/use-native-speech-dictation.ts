import { useCallback, useEffect, useRef, useState } from "react";

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

function describeSpeechRecognitionError(error: NativeSpeechRecognitionErrorEvent): string {
	switch (error.error) {
		case "not-allowed":
		case "service-not-allowed":
			return "Microphone access is blocked for this browser or page.";
		case "audio-capture":
			return "No microphone was detected.";
		case "language-not-supported":
			return "Speech recognition is not available for this browser language.";
		case "network":
			return "Speech recognition could not reach the browser service.";
		case "no-speech":
			return "No speech was detected. Try again or type the description.";
		case "aborted":
			return "Voice input stopped.";
		default:
			return error.message || "Voice input stopped unexpectedly.";
	}
}

export function useNativeSpeechDictation(onTranscript: (transcript: string) => void): UseNativeSpeechDictationResult {
	const recognitionRef = useRef<NativeSpeechRecognition | null>(null);
	const onTranscriptRef = useRef(onTranscript);
	onTranscriptRef.current = onTranscript;

	const [isSupported] = useState(() => getNativeSpeechRecognitionConstructor() !== null);
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
		const Recognition = getNativeSpeechRecognitionConstructor();
		if (!Recognition) {
			setStatus("error");
			setMessage("Voice input is not supported in this browser.");
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
			setMessage(describeSpeechRecognitionError(event));
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

	return { isSupported, status, message, interimTranscript, start, stop, reset };
}
