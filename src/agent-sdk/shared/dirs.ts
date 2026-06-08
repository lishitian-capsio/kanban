/**
 * Minimal directory helpers for embedded omp source.
 *
 * Provides only the functions needed by env.ts and logger.ts.
 * Uses Kanban's config directory convention (~/.kanban/pi/).
 *
 * The full omp dirs.ts is intentionally excluded — Kanban has its own
 * directory management in src/projects/ and src/state/.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Config root for embedded pi agent (~/.kanban/pi). */
export function getConfigRootDir(): string {
	return path.join(os.homedir(), ".kanban", "pi");
}

/** Agent config directory (~/.kanban/pi/agent). */
export function getAgentDir(): string {
	return path.join(getConfigRootDir(), "agent");
}

/** Logs directory (~/.kanban/pi/logs). */
export function getLogsDir(): string {
	return path.join(getConfigRootDir(), "logs");
}

/** Agent database path (~/.kanban/pi/agent/agent.db). */
export function getAgentDbPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "agent.db");
}

/** Model database path (~/.kanban/pi/agent/data/models.db). */
export function getModelDbPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "data", "models.db");
}

/** Ensure a directory exists, return the path. */
export function ensureDirExists(dir: string): string {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

const INSTALL_ID_FILE = "install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let cachedInstallId: string | null = null;

/** Stable install-specific UUID, persisted under the config root. */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getConfigRootDir(), INSTALL_ID_FILE);

	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (UUID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
	} catch {}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, next + "\n", "utf8");
	} catch {}
	cachedInstallId = next;
	return next;
}

/** Helper to resolve a subdirectory under the agent dir. */
export function agentSubdir(agentDir: string | undefined, ...segments: string[]): string {
	return path.join(agentDir ?? getAgentDir(), ...segments);
}

/** Get a cache directory path under the agent dir. */
export function getCacheDir(subdir?: string): string {
	const base = path.join(getAgentDir(), "cache");
	return subdir ? path.join(base, subdir) : base;
}
