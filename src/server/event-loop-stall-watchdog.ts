import { createLogger } from "../logging";

const log = createLogger("stall-watchdog");

/**
 * Event-loop stall watchdog.
 *
 * A synchronous infinite loop / blocking call on the main thread freezes the
 * runtime at 100% CPU and never yields — so nothing ON the main thread (timers,
 * signal-driven JS) can observe it. The only reliable observer is a second
 * thread. This module runs a tiny Worker that watches a {@link SharedArrayBuffer}
 * heartbeat the main loop bumps on a short timer; when the heartbeat stops
 * advancing for longer than the threshold, the Worker reports WHERE the main
 * thread was last working (a "breadcrumb" string the hot paths set via
 * {@link markStall}) plus the stall duration.
 *
 * It exists to turn the next move-to-done freeze (filed as a 100% CPU hard hang
 * that needs a manual kill) into a precise, single hot-path attribution instead
 * of a guess — see the systematic-debugging investigation. Overhead is one
 * 250ms unref'd timer on the main thread plus a 500ms poll on the Worker.
 */

/** How often the main thread bumps the liveness counter. */
export const HEARTBEAT_INTERVAL_MS = 250;
/** How often the Worker samples the counter. */
export const WORKER_POLL_INTERVAL_MS = 500;
/** Default time the loop must be blocked before the Worker reports a stall. */
export const DEFAULT_STALL_THRESHOLD_MS = 3_000;
/** Max breadcrumb length retained in the shared buffer (UTF-16 code units). */
export const BREADCRUMB_MAX_CHARS = 96;

// SharedArrayBuffer layout, as an Int32Array:
//   [0]                          heartbeat counter (main increments)
//   [1]                          current breadcrumb length (UTF-16 units)
//   [2 .. 2+BREADCRUMB_MAX_CHARS) breadcrumb UTF-16 code units
const SAB_INDEX_COUNTER = 0;
const SAB_INDEX_BREADCRUMB_LEN = 1;
const SAB_INDEX_BREADCRUMB_START = 2;

/** Number of Int32 slots the watchdog's shared buffer needs. */
export const STALL_WATCHDOG_SAB_INT32_LENGTH = SAB_INDEX_BREADCRUMB_START + BREADCRUMB_MAX_CHARS;

/**
 * Write a breadcrumb string into the shared buffer (truncated to
 * {@link BREADCRUMB_MAX_CHARS}). The chars are written before the length so a
 * concurrent reader that observes the new length always sees fully-written
 * chars; an in-flight reader may briefly see the previous length, which is
 * harmless for a diagnostic.
 */
export function writeBreadcrumb(view: Int32Array, text: string): void {
	const length = Math.min(text.length, BREADCRUMB_MAX_CHARS);
	for (let i = 0; i < length; i += 1) {
		Atomics.store(view, SAB_INDEX_BREADCRUMB_START + i, text.charCodeAt(i));
	}
	Atomics.store(view, SAB_INDEX_BREADCRUMB_LEN, length);
}

/** Read the breadcrumb string previously written by {@link writeBreadcrumb}. */
export function readBreadcrumb(view: Int32Array): string {
	const length = Math.min(Math.max(Atomics.load(view, SAB_INDEX_BREADCRUMB_LEN), 0), BREADCRUMB_MAX_CHARS);
	let result = "";
	for (let i = 0; i < length; i += 1) {
		result += String.fromCharCode(Atomics.load(view, SAB_INDEX_BREADCRUMB_START + i));
	}
	return result;
}

export interface StallClassification {
	stalled: boolean;
	stalledMs: number;
}

/**
 * Decide whether a run of polls with no counter change constitutes a stall.
 * Pure so the detection threshold logic is unit-testable without a Worker.
 */
export function classifyStall(input: {
	consecutiveMissedPolls: number;
	pollIntervalMs: number;
	thresholdMs: number;
}): StallClassification {
	const stalledMs = input.consecutiveMissedPolls * input.pollIntervalMs;
	return { stalled: stalledMs >= input.thresholdMs, stalledMs };
}

export interface EventLoopStallWatchdog {
	/**
	 * Record the operation the main thread is about to run, so a stall report can
	 * attribute the freeze. Keep it short (`"trpc:saveState task=abc123"`); only
	 * the most recent mark before a stall is retained.
	 */
	mark(label: string, detail?: string): void;
	/**
	 * Whether the main event loop is currently observed as stalled — flips true on
	 * the Worker's `stall` report and back to false on `recovered`. Reused as the
	 * stall indicator for the runtime ops metrics bar (no stderr parsing).
	 */
	isStalled(): boolean;
	/** Tear down the Worker and the heartbeat timer. */
	stop(): Promise<void>;
}

const NOOP_WATCHDOG: EventLoopStallWatchdog = {
	mark: () => {},
	isStalled: () => false,
	stop: async () => {},
};

// Module singleton so hot paths can call the free `markStall` without threading
// the instance through every call site.
let activeWatchdog: EventLoopStallWatchdog = NOOP_WATCHDOG;

/** Record a breadcrumb on the active watchdog (no-op when none is running). */
export function markStall(label: string, detail?: string): void {
	activeWatchdog.mark(label, detail);
}

/**
 * Whether the active watchdog currently observes a stalled main event loop
 * (false when no watchdog is running). Lets the ops metrics sampler read the
 * stall signal in-process without parsing the watchdog's stderr.
 */
export function isEventLoopStalled(): boolean {
	return activeWatchdog.isStalled();
}

// The Worker runs as standalone plain JS (no bundler-resolved imports) so it
// survives the single-file `dist/cli.js` build. It only does Atomics polling +
// emergency stderr output, so it needs no Kanban modules. Built as a string and
// loaded via a blob URL.
function buildWorkerSource(thresholdMs: number): string {
	return `
const SAB_INDEX_COUNTER = ${SAB_INDEX_COUNTER};
const SAB_INDEX_BREADCRUMB_LEN = ${SAB_INDEX_BREADCRUMB_LEN};
const SAB_INDEX_BREADCRUMB_START = ${SAB_INDEX_BREADCRUMB_START};
const BREADCRUMB_MAX_CHARS = ${BREADCRUMB_MAX_CHARS};
const POLL_MS = ${WORKER_POLL_INTERVAL_MS};
const THRESHOLD_MS = ${thresholdMs};

function readBreadcrumb(view) {
	const raw = Atomics.load(view, SAB_INDEX_BREADCRUMB_LEN);
	const length = Math.min(Math.max(raw, 0), BREADCRUMB_MAX_CHARS);
	let result = "";
	for (let i = 0; i < length; i += 1) {
		result += String.fromCharCode(Atomics.load(view, SAB_INDEX_BREADCRUMB_START + i));
	}
	return result;
}

self.onmessage = (event) => {
	const view = new Int32Array(event.data.sab);
	let lastCounter = Atomics.load(view, SAB_INDEX_COUNTER);
	let missedPolls = 0;
	let reported = false;

	setInterval(() => {
		const current = Atomics.load(view, SAB_INDEX_COUNTER);
		if (current !== lastCounter) {
			if (reported) {
				const recoveredMs = missedPolls * POLL_MS;
				const line = JSON.stringify({ level: "warn", source: "stall-watchdog", event: "recovered", stalledMs: recoveredMs }) + "\\n";
				try { process.stderr.write("[stall-watchdog] " + line); } catch {}
				self.postMessage({ type: "recovered", stalledMs: recoveredMs });
			}
			lastCounter = current;
			missedPolls = 0;
			reported = false;
			return;
		}
		missedPolls += 1;
		const stalledMs = missedPolls * POLL_MS;
		if (stalledMs < THRESHOLD_MS) {
			return;
		}
		const breadcrumb = readBreadcrumb(view);
		// Emergency stderr write FIRST: if the main thread never recovers (the user
		// hard-kills the frozen process), the postMessage below is never drained, so
		// this direct line is the only record that survives. This is the documented
		// "process is wedged" diagnostic exception to the no-console rule.
		const line = JSON.stringify({ level: "error", source: "stall-watchdog", event: "stall", stalledMs, breadcrumb }) + "\\n";
		try { process.stderr.write("[stall-watchdog] " + line); } catch {}
		// Re-report every ~5s while still stalled so a long freeze leaves a trail.
		if (!reported || stalledMs % 5000 < POLL_MS) {
			self.postMessage({ type: "stall", stalledMs, breadcrumb });
		}
		reported = true;
	}, POLL_MS);
};
`;
}

export interface StartEventLoopStallWatchdogOptions {
	/** Stall threshold in ms (default {@link DEFAULT_STALL_THRESHOLD_MS}). */
	thresholdMs?: number;
}

/**
 * Start the watchdog and install it as the process-wide singleton. Safe to call
 * once at server startup; a no-op stub is returned (and nothing is installed)
 * when the Worker/SharedArrayBuffer primitives are unavailable, so importing or
 * starting this never throws in a constrained runtime.
 */
export function startEventLoopStallWatchdog(options: StartEventLoopStallWatchdogOptions = {}): EventLoopStallWatchdog {
	const thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;

	if (typeof SharedArrayBuffer === "undefined" || typeof Worker === "undefined") {
		log.warn("event-loop stall watchdog unavailable (no SharedArrayBuffer/Worker); skipping");
		return NOOP_WATCHDOG;
	}

	let worker: Worker | null = null;
	let blobUrl: string | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let stalled = false;
	try {
		const sab = new SharedArrayBuffer(STALL_WATCHDOG_SAB_INT32_LENGTH * Int32Array.BYTES_PER_ELEMENT);
		const view = new Int32Array(sab);
		writeBreadcrumb(view, "idle");

		const source = buildWorkerSource(thresholdMs);
		blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
		worker = new Worker(blobUrl);
		worker.onmessage = (event: MessageEvent) => {
			const data = event.data as { type?: string; stalledMs?: number; breadcrumb?: string };
			if (data?.type === "stall") {
				stalled = true;
				log.error("main event loop stalled — runtime is blocked (likely a synchronous loop or blocking call)", {
					stalledMs: data.stalledMs,
					operation: data.breadcrumb || "unknown",
				});
			} else if (data?.type === "recovered") {
				stalled = false;
				log.warn("main event loop recovered after a stall", { stalledMs: data.stalledMs });
			}
		};
		worker.postMessage({ sab });
		// Do not keep the process alive solely for the watchdog.
		(worker as unknown as { unref?: () => void }).unref?.();

		heartbeatTimer = setInterval(() => {
			Atomics.add(view, SAB_INDEX_COUNTER, 1);
		}, HEARTBEAT_INTERVAL_MS);
		(heartbeatTimer as unknown as { unref?: () => void }).unref?.();

		const watchdog: EventLoopStallWatchdog = {
			mark: (label, detail) => {
				writeBreadcrumb(view, detail ? `${label} ${detail}` : label);
			},
			isStalled: () => stalled,
			stop: async () => {
				if (heartbeatTimer) {
					clearInterval(heartbeatTimer);
					heartbeatTimer = null;
				}
				worker?.terminate();
				worker = null;
				if (blobUrl) {
					URL.revokeObjectURL(blobUrl);
					blobUrl = null;
				}
				if (activeWatchdog === watchdog) {
					activeWatchdog = NOOP_WATCHDOG;
				}
			},
		};
		activeWatchdog = watchdog;
		log.info("event-loop stall watchdog started", { thresholdMs });
		return watchdog;
	} catch (error) {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
		}
		worker?.terminate();
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
		}
		log.warn("failed to start event-loop stall watchdog; continuing without it", { error });
		return NOOP_WATCHDOG;
	}
}
