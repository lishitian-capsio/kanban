import { createLogger } from "../../logging";
import { QueryCancelledError, QueryTimeoutError } from "../errors";

const log = createLogger("db:query-deadline");

/** Why work was abandoned before it finished. */
export type AbandonReason = "timeout" | "cancelled";

export interface DeadlineOptions {
	/** Reject after this many ms. Absent / ≤ 0 disables the timeout. */
	timeoutMs?: number;
	/** External cancellation signal. */
	signal?: AbortSignal;
	/**
	 * Fire-and-forget teardown invoked exactly once when work is abandoned (timeout or
	 * abort) — e.g. dropping the connection's pooled driver so a runaway query can't keep
	 * the runtime waiting. Errors (sync or async) are swallowed; runtime control is
	 * returned to the caller regardless.
	 */
	onAbandon?: (reason: AbandonReason) => void | Promise<void>;
}

/**
 * Run `run()` under a timeout and/or abort signal so a runaway query never hangs the
 * runtime. On timeout/abort the returned promise rejects immediately and `onAbandon` is
 * fired; the underlying work promise is detached (its later settlement is ignored, with a
 * no-op catch so it can't surface as an unhandled rejection).
 */
export async function runWithDeadline<T>(run: () => Promise<T>, options: DeadlineOptions): Promise<T> {
	const { timeoutMs, signal } = options;
	if (signal?.aborted) {
		throw new QueryCancelledError();
	}

	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;

	const fireAbandon = (reason: AbandonReason): void => {
		try {
			void Promise.resolve(options.onAbandon?.(reason)).catch((error) => {
				log.warn("query abandon teardown failed", { reason, error });
			});
		} catch (error) {
			log.warn("query abandon teardown threw", { reason, error });
		}
	};

	const work = run();
	// Detach: if we reject early via timeout/abort, the original work may still settle later.
	work.catch(() => {});

	try {
		return await new Promise<T>((resolve, reject) => {
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timer = setTimeout(() => {
					if (settled) {
						return;
					}
					settled = true;
					fireAbandon("timeout");
					reject(new QueryTimeoutError(timeoutMs));
				}, timeoutMs);
			}
			if (signal) {
				abortListener = () => {
					if (settled) {
						return;
					}
					settled = true;
					fireAbandon("cancelled");
					reject(new QueryCancelledError());
				};
				signal.addEventListener("abort", abortListener, { once: true });
			}
			work.then(
				(value) => {
					if (settled) {
						return;
					}
					settled = true;
					resolve(value);
				},
				(error) => {
					if (settled) {
						return;
					}
					settled = true;
					reject(error);
				},
			);
		});
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		if (signal && abortListener) {
			signal.removeEventListener("abort", abortListener);
		}
	}
}
