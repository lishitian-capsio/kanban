import type { RuntimeOpsMetrics } from "../core/api-contract";
import { createLogger } from "../logging";
import { isEventLoopStalled } from "./event-loop-stall-watchdog";

const log = createLogger("runtime-ops-metrics");

/**
 * Runtime ops metrics sampler.
 *
 * Samples the runtime process's resident memory and CPU usage on a modest
 * interval and combines them with the event-loop stall watchdog's in-process
 * signal into a {@link RuntimeOpsMetrics} snapshot, which it hands to a callback
 * (the runtime hub broadcasts it as a low-frequency `runtime_metrics_updated`
 * message). These power the VSCode-style status bar at the bottom of the
 * Kanban-agent sidebar.
 *
 * It is deliberately cheap: one unref'd timer reading `process.memoryUsage()` /
 * `process.cpuUsage()` deltas — no second loop, and it reuses the watchdog's
 * already-running stall observer rather than polling the loop itself.
 */

/** Default sampling cadence — low-frequency, like the board-sync badge. */
export const DEFAULT_OPS_METRICS_INTERVAL_MS = 2_500;

/** A user/system CPU time pair in microseconds, as returned by `process.cpuUsage()`. */
export interface CpuUsageSample {
	user: number;
	system: number;
}

/**
 * Microseconds of CPU time (user + system) consumed between two
 * `process.cpuUsage()` samples. Pure so the delta math is unit-testable.
 */
export function cpuUsageDeltaMicros(prev: CpuUsageSample, next: CpuUsageSample): number {
	return next.user - prev.user + (next.system - prev.system);
}

/**
 * CPU usage as a percentage of one core over the sampling interval: CPU
 * microseconds consumed divided by wall-clock microseconds elapsed. Can exceed
 * 100 on multi-core machines (CPU time sums across cores); clamps the floor at 0
 * so a clock regression or counter wrap never reports a negative percentage.
 * Pure so it can be unit-tested without sampling the live process.
 */
export function computeCpuPercent(input: { cpuDeltaMicros: number; elapsedMs: number }): number {
	if (input.elapsedMs <= 0) {
		return 0;
	}
	const elapsedMicros = input.elapsedMs * 1_000;
	const percent = (input.cpuDeltaMicros / elapsedMicros) * 100;
	return percent > 0 ? percent : 0;
}

export interface RuntimeOpsMetricsSampler {
	/** Stop sampling and clear the timer. */
	stop(): void;
}

export interface StartRuntimeOpsMetricsSamplerOptions {
	/** Sampling cadence (default {@link DEFAULT_OPS_METRICS_INTERVAL_MS}). */
	intervalMs?: number;
	/** Receives each sampled snapshot. */
	onSample: (metrics: RuntimeOpsMetrics) => void;
	/** Stall signal source (defaults to the shared stall watchdog). */
	isStalled?: () => boolean;
	/** Wall-clock source, injectable for tests (defaults to `Date.now`). */
	now?: () => number;
	/** CPU usage source, injectable for tests (defaults to `process.cpuUsage`). */
	readCpuUsage?: () => CpuUsageSample;
	/** RSS source, injectable for tests (defaults to `process.memoryUsage().rss`). */
	readRssBytes?: () => number;
}

/**
 * Start sampling runtime ops metrics on an interval. The timer is unref'd so the
 * sampler never keeps the process alive on its own. Returns a handle to stop it.
 */
export function startRuntimeOpsMetricsSampler(options: StartRuntimeOpsMetricsSamplerOptions): RuntimeOpsMetricsSampler {
	const intervalMs = options.intervalMs ?? DEFAULT_OPS_METRICS_INTERVAL_MS;
	const isStalled = options.isStalled ?? isEventLoopStalled;
	const now = options.now ?? (() => Date.now());
	const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
	const readRssBytes = options.readRssBytes ?? (() => process.memoryUsage().rss);

	let lastCpu = readCpuUsage();
	let lastSampledAtMs = now();

	const timer = setInterval(() => {
		try {
			const sampledAtMs = now();
			const cpu = readCpuUsage();
			const cpuPercent = computeCpuPercent({
				cpuDeltaMicros: cpuUsageDeltaMicros(lastCpu, cpu),
				elapsedMs: sampledAtMs - lastSampledAtMs,
			});
			lastCpu = cpu;
			lastSampledAtMs = sampledAtMs;
			options.onSample({
				rssBytes: readRssBytes(),
				cpuPercent,
				eventLoopStalled: isStalled(),
				sampledAtMs,
			});
		} catch (error) {
			log.warn("failed to sample runtime ops metrics", { error });
		}
	}, intervalMs);
	(timer as unknown as { unref?: () => void }).unref?.();

	log.info("runtime ops metrics sampler started", { intervalMs });

	return {
		stop: () => {
			clearInterval(timer);
		},
	};
}
