// Settings → Project "Voice input (speech-to-text)" control. Configures the machine-local
// STT endpoint + key that the chat composer's microphone uploads recordings to. Reads/drives
// the machine-global `stt` tRPC router via {@link useSttConfig}: shows whether it's configured,
// edits the endpoint/model/language, and stores (or removes) the key. The API key is never
// returned over the wire — only a masked preview — so the field stays blank on load and an
// empty save keeps the existing key. Works with any OpenAI-compatible transcription endpoint
// (cloud or self-hosted whisper.cpp / faster-whisper). Mirrors {@link GithubAuthSetting}.

import { AlertTriangle, Mic, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useSttConfig } from "@/hooks/use-stt-config";

const inputClass =
	"h-8 w-full rounded-md border border-border bg-surface-2 px-2.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40";

export function SttConfigSetting({ workspaceId }: { workspaceId: string | null }): React.ReactElement {
	const { status, statusLoading, statusError, isSaving, isClearing, save, clear, refreshStatus } =
		useSttConfig(workspaceId);

	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [language, setLanguage] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [hydrated, setHydrated] = useState(false);

	// Seed the form from the loaded status once (the API key never comes back — the field
	// stays blank, with the masked preview shown as the placeholder).
	useEffect(() => {
		if (status && !hydrated) {
			setBaseUrl(status.baseUrl ?? "");
			setModel(status.model ?? "");
			setLanguage(status.language ?? "");
			setHydrated(true);
		}
	}, [hydrated, status]);

	const firstLoad = statusLoading && status === null;
	const unreachable = statusError !== null && status === null;
	const canSave = baseUrl.trim().length > 0 && !isSaving;

	const handleSave = async () => {
		const ok = await save({
			baseUrl: baseUrl.trim(),
			model: model.trim() || undefined,
			language: language.trim() || undefined,
			// Blank means "keep the existing key"; merge logic on the backend treats undefined as keep.
			apiKey: apiKey.length > 0 ? apiKey : undefined,
		});
		if (ok) {
			setApiKey("");
		}
	};

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
				<Mic size={13} />
				Voice input (speech-to-text)
			</h6>

			{firstLoad ? (
				<div className="flex items-center gap-2 text-text-secondary text-[13px]">
					<Spinner size={14} />
					Loading…
				</div>
			) : unreachable ? (
				<div className="flex items-start gap-2 rounded-md border border-status-orange/30 bg-status-orange/5 p-2.5">
					<AlertTriangle size={14} className="mt-0.5 shrink-0 text-status-orange" />
					<div className="min-w-0 flex-1">
						<p className="text-text-primary text-[13px] m-0">Couldn't reach the speech-to-text service.</p>
						<Button
							variant="ghost"
							size="sm"
							className="mt-1.5"
							icon={statusLoading ? <Spinner size={12} /> : <RefreshCw size={13} />}
							onClick={() => void refreshStatus()}
							disabled={statusLoading}
						>
							Retry
						</Button>
					</div>
				</div>
			) : (
				<>
					<div className="flex items-center gap-2 mb-3">
						<span
							className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
								status?.configured ? "bg-status-green/10 text-status-green" : "bg-surface-2 text-text-tertiary"
							}`}
						>
							{status?.configured ? "Configured" : "Not configured"}
						</span>
						{statusError !== null ? (
							<span className="text-status-orange text-[11px]">Couldn't refresh — showing last known.</span>
						) : null}
					</div>

					<div className="flex flex-col gap-2.5">
						<label className="flex flex-col gap-1">
							<span className="text-[11px] text-text-secondary">Base URL (OpenAI-compatible)</span>
							<input
								type="text"
								value={baseUrl}
								onChange={(event) => setBaseUrl(event.target.value)}
								placeholder="https://api.openai.com/v1"
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								className={inputClass}
							/>
						</label>

						<div className="flex gap-2.5">
							<label className="flex flex-1 flex-col gap-1">
								<span className="text-[11px] text-text-secondary">Model</span>
								<input
									type="text"
									value={model}
									onChange={(event) => setModel(event.target.value)}
									placeholder="whisper-1"
									spellCheck={false}
									autoCapitalize="off"
									autoCorrect="off"
									className={inputClass}
								/>
							</label>
							<label className="flex w-28 flex-col gap-1">
								<span className="text-[11px] text-text-secondary">Language</span>
								<input
									type="text"
									value={language}
									onChange={(event) => setLanguage(event.target.value)}
									placeholder="auto"
									spellCheck={false}
									autoCapitalize="off"
									autoCorrect="off"
									className={inputClass}
								/>
							</label>
						</div>

						<label className="flex flex-col gap-1">
							<span className="text-[11px] text-text-secondary">API key</span>
							<input
								type="password"
								value={apiKey}
								onChange={(event) => setApiKey(event.target.value)}
								placeholder={
									status?.hasApiKey
										? `${status.apiKeyPreview ?? "••••"} — leave blank to keep`
										: "Optional for self-hosted endpoints"
								}
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								className={inputClass}
							/>
						</label>
					</div>

					<div className="mt-3 flex items-center gap-2">
						<Button
							variant="primary"
							size="sm"
							onClick={() => void handleSave()}
							disabled={!canSave}
							icon={isSaving ? <Spinner size={12} /> : undefined}
						>
							{isSaving ? "Saving…" : "Save"}
						</Button>
						{status?.configured ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => void clear()}
								disabled={isClearing}
								icon={isClearing ? <Spinner size={12} /> : undefined}
							>
								Remove
							</Button>
						) : null}
					</div>

					<p className="text-text-secondary text-[12px] mt-3 mb-0">
						The microphone button in chat records a short clip and transcribes it here, filling the message box
						for you to review before sending. Works with any OpenAI-compatible{" "}
						<span className="font-mono">/audio/transcriptions</span> endpoint (cloud or self-hosted whisper.cpp /
						faster-whisper). The key is stored locally on this machine and never committed. Microphone access
						requires HTTPS or localhost.
					</p>
				</>
			)}
		</div>
	);
}
