import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryCancelledError, QueryTimeoutError } from "../../../src/db/errors";
import { runWithDeadline } from "../../../src/db/execution/query-deadline";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("runWithDeadline", () => {
	it("resolves with the value when work finishes before the deadline", async () => {
		const result = await runWithDeadline(async () => "ok", { timeoutMs: 1000 });
		expect(result).toBe("ok");
	});

	it("does not impose a deadline when timeoutMs is absent or zero", async () => {
		expect(await runWithDeadline(async () => 1, {})).toBe(1);
		expect(await runWithDeadline(async () => 2, { timeoutMs: 0 })).toBe(2);
	});

	it("rejects with QueryTimeoutError and abandons work when the deadline elapses", async () => {
		vi.useFakeTimers();
		const onAbandon = vi.fn();
		const p = runWithDeadline<never>(() => new Promise<never>(() => {}), { timeoutMs: 1000, onAbandon });
		const assertion = expect(p).rejects.toBeInstanceOf(QueryTimeoutError);
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
		expect(onAbandon).toHaveBeenCalledWith("timeout");
	});

	it("rejects an already-aborted signal without ever starting the work", async () => {
		const controller = new AbortController();
		controller.abort();
		const run = vi.fn(async () => "nope");
		await expect(runWithDeadline(run, { signal: controller.signal })).rejects.toBeInstanceOf(QueryCancelledError);
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects with QueryCancelledError and abandons work when aborted mid-flight", async () => {
		const controller = new AbortController();
		const onAbandon = vi.fn();
		const gate = deferred<string>();
		const p = runWithDeadline(() => gate.promise, { signal: controller.signal, onAbandon });
		controller.abort();
		await expect(p).rejects.toBeInstanceOf(QueryCancelledError);
		expect(onAbandon).toHaveBeenCalledWith("cancelled");
	});

	it("still rejects even if the abandon callback throws", async () => {
		vi.useFakeTimers();
		const p = runWithDeadline<never>(() => new Promise<never>(() => {}), {
			timeoutMs: 100,
			onAbandon: () => {
				throw new Error("teardown boom");
			},
		});
		const assertion = expect(p).rejects.toBeInstanceOf(QueryTimeoutError);
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
	});
});
