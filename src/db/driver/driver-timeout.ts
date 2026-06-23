/**
 * Validate a server-side query deadline to a non-negative integer of milliseconds (0 ⇒ disabled).
 * Shared by the Postgres (`statement_timeout`) and MySQL (`max_execution_time`) drivers, which
 * inline the value into a `SET` statement — so it must be a plain validated integer, never raw input.
 */
export function serverTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return 0;
	}
	return Math.trunc(timeoutMs);
}
