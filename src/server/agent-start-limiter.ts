// Host-wide throttle for agent session startups.
//
// When many tasks are started at once (e.g. a batch kicked off from the board),
// each launch spawns a real CLI process (claude/codex/…) or a pi runtime and
// writes adapter config files. Left unthrottled, N simultaneous starts produce
// N concurrent spawn + file-write bursts — the most likely source of CPU thrash
// on bulk startup. This caps how many session startups run concurrently; the
// rest queue and drain as slots free up.
//
// Deliberately scoped to the orchestration boundary (trpc/runtime-api.ts), NOT
// the lean session-manager spawn path, which stays lock-free by design.

import { availableParallelism, cpus } from "node:os";
import pLimit, { type LimitFunction } from "p-limit";
import { createLogger } from "../logging/logger";

const log = createLogger("agent-start-limiter");

/** Env var overriding the max number of agent session startups run concurrently. */
export const AGENT_START_CONCURRENCY_ENV = "KANBAN_MAX_CONCURRENT_AGENT_STARTS";

export interface AgentStartLimiter {
	/** Run `fn` once a concurrency slot is free; queues otherwise. */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** Configured concurrency limit (≥ 1). */
	readonly concurrency: number;
	/** Number of startups currently running. */
	readonly activeCount: number;
	/** Number of startups waiting for a slot. */
	readonly pendingCount: number;
}

/**
 * Resolve the configured concurrency from the raw env value, falling back to the
 * CPU count for an absent, empty, or invalid (non-numeric / non-positive) value.
 * Always returns an integer ≥ 1. Pure for unit testing.
 */
export function resolveAgentStartConcurrency(rawValue: string | undefined, cpuCount: number): number {
	const cpuDefault = Math.max(1, Math.floor(cpuCount));
	if (rawValue === undefined) {
		return cpuDefault;
	}
	const trimmed = rawValue.trim();
	if (trimmed === "") {
		return cpuDefault;
	}
	const parsed = Number(trimmed);
	if (!Number.isFinite(parsed) || parsed < 1) {
		return cpuDefault;
	}
	return Math.floor(parsed);
}

/** Wrap a p-limit instance behind the {@link AgentStartLimiter} contract. */
export function createAgentStartLimiter(concurrency: number): AgentStartLimiter {
	const limit: LimitFunction = pLimit(Math.max(1, Math.floor(concurrency)));
	return {
		run: (fn) => limit(fn),
		get concurrency() {
			return limit.concurrency;
		},
		get activeCount() {
			return limit.activeCount;
		},
		get pendingCount() {
			return limit.pendingCount;
		},
	};
}

function resolveHostCpuCount(): number {
	try {
		return availableParallelism();
	} catch {
		return cpus().length;
	}
}

let sharedLimiter: AgentStartLimiter | null = null;

/** Lazily-initialized, host-wide singleton limiter (env- and CPU-derived). */
export function getAgentStartLimiter(): AgentStartLimiter {
	if (!sharedLimiter) {
		const concurrency = resolveAgentStartConcurrency(process.env[AGENT_START_CONCURRENCY_ENV], resolveHostCpuCount());
		sharedLimiter = createAgentStartLimiter(concurrency);
		log.info("Agent start concurrency limiter initialized", { concurrency });
	}
	return sharedLimiter;
}

/** Convenience wrapper around the shared limiter's {@link AgentStartLimiter.run}. */
export function limitAgentStart<T>(fn: () => Promise<T>): Promise<T> {
	return getAgentStartLimiter().run(fn);
}
