/**
 * Shared types + persisted schema for the machine-local speech-to-text (STT) config
 * that backs the chat composer's voice input. Stored alongside the other machine-local
 * secrets (`~/.kanban/settings/stt-config.json`, same convention as `github-auth.json`
 * / `passcode.json`): never committed, never written into `<repo>/.kanban`, owner-only.
 *
 * Intentionally isolated from the pi/omp agent-model provider store — STT is its own
 * endpoint + key and must not share storage or types.
 */
import { z } from "zod";

/** On-disk shape of `~/.kanban/settings/stt-config.json`. */
export const persistedSttConfigSchema = z.object({
	/** OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`), normalized on save. */
	baseUrl: z.string().min(1),
	/** STT model id (e.g. `whisper-1`, `gpt-4o-transcribe`). */
	model: z.string().min(1),
	/** Optional API key; self-hosted whisper.cpp/faster-whisper endpoints may need none. */
	apiKey: z.string().min(1).optional(),
	/** Optional default recognition language (ISO-639-1, e.g. `zh`). */
	language: z.string().min(1).optional(),
	/** Epoch ms the config was last saved. */
	updatedAt: z.number().int().positive().optional(),
});

export type PersistedSttConfig = z.infer<typeof persistedSttConfigSchema>;
