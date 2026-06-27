// Orchestrates the machine-local STT config + the transcription egress for the
// `stt` tRPC router. Mtime-caches the disk read so a config written by a separate
// process (or another runtime) is picked up without a restart, mirroring
// `github-auth-service.ts`. The API key never leaves the runtime: `getStatus`
// returns only a masked, secret-free projection.

import type {
	RuntimeSttSaveRequest,
	RuntimeSttStatus,
	RuntimeSttTranscribeRequest,
	RuntimeSttTranscribeResponse,
} from "../core/api-contract";
import { createLogger } from "../logging";
import { deriveSttStatus, mergeSttConfigForSave } from "./stt-config";
import {
	clearPersistedSttConfig,
	getSttConfigFilePath,
	readPersistedSttConfig,
	statSttConfigMtimeMs,
	writePersistedSttConfig,
} from "./stt-config-store";
import { SttTranscriptionError, transcribeAudio, validateAudioByteLength } from "./stt-transcribe";
import type { PersistedSttConfig } from "./stt-types";

const log = createLogger("stt.service");

export interface SttConfigServiceOptions {
	/** Override the config file path (tests). Defaults to the machine-home settings path. */
	resolvePath?: () => string;
}

export class SttConfigService {
	private readonly resolvePath: () => string;
	private cache: { mtimeMs: number | null; config: PersistedSttConfig | null } | null = null;

	constructor(options: SttConfigServiceOptions = {}) {
		this.resolvePath = options.resolvePath ?? getSttConfigFilePath;
	}

	private async loadConfig(): Promise<PersistedSttConfig | null> {
		const path = this.resolvePath();
		const mtimeMs = await statSttConfigMtimeMs(path);
		if (this.cache && this.cache.mtimeMs === mtimeMs) {
			return this.cache.config;
		}
		const config = mtimeMs === null ? null : await readPersistedSttConfig(path);
		this.cache = { mtimeMs, config };
		return config;
	}

	/** Secret-free status for the Settings UI. */
	async getStatus(): Promise<RuntimeSttStatus> {
		return deriveSttStatus(await this.loadConfig());
	}

	/** Persist an updated config (merging onto the existing one) and return the new status. */
	async save(request: RuntimeSttSaveRequest): Promise<RuntimeSttStatus> {
		const existing = await this.loadConfig();
		const next = mergeSttConfigForSave(existing, request);
		const path = this.resolvePath();
		await writePersistedSttConfig(path, next);
		this.cache = { mtimeMs: await statSttConfigMtimeMs(path), config: next };
		return deriveSttStatus(next);
	}

	/** Remove the stored config and return the (now unconfigured) status. */
	async clear(): Promise<RuntimeSttStatus> {
		await clearPersistedSttConfig(this.resolvePath());
		this.cache = { mtimeMs: null, config: null };
		return deriveSttStatus(null);
	}

	/** Decode the uploaded clip and transcribe it via the configured endpoint. */
	async transcribe(request: RuntimeSttTranscribeRequest): Promise<RuntimeSttTranscribeResponse> {
		const config = await this.loadConfig();
		if (!config) {
			throw new SttTranscriptionError(
				"Speech-to-text is not configured. Add an STT endpoint and key in Settings → Project.",
			);
		}
		const bytes = Buffer.from(request.audioData, "base64");
		const sizeError = validateAudioByteLength(bytes.byteLength);
		if (sizeError) {
			throw new SttTranscriptionError(sizeError);
		}
		const text = await transcribeAudio(config, { bytes, mime: request.mime, language: request.language });
		log.debug("transcribed audio clip", { bytes: bytes.byteLength, chars: text.length });
		return { text };
	}
}

let singleton: SttConfigService | null = null;

/** Process-wide STT config service (machine-global, like the GitHub auth service). */
export function getSttConfigService(): SttConfigService {
	if (!singleton) {
		singleton = new SttConfigService();
	}
	return singleton;
}
