import { describe, expect, it } from "vitest";
import { createAgentStartLimiter, resolveAgentStartConcurrency } from "../../src/server/agent-start-limiter";

describe("resolveAgentStartConcurrency", () => {
	it("falls back to the CPU count when the env value is absent", () => {
		expect(resolveAgentStartConcurrency(undefined, 8)).toBe(8);
	});

	it("falls back to the CPU count for an empty or whitespace value", () => {
		expect(resolveAgentStartConcurrency("", 6)).toBe(6);
		expect(resolveAgentStartConcurrency("   ", 6)).toBe(6);
	});

	it("uses a valid positive integer override", () => {
		expect(resolveAgentStartConcurrency("4", 16)).toBe(4);
	});

	it("floors fractional overrides", () => {
		expect(resolveAgentStartConcurrency("3.9", 16)).toBe(3);
	});

	it("rejects non-positive and non-numeric overrides, falling back to the CPU count", () => {
		expect(resolveAgentStartConcurrency("0", 6)).toBe(6);
		expect(resolveAgentStartConcurrency("-2", 6)).toBe(6);
		expect(resolveAgentStartConcurrency("abc", 6)).toBe(6);
	});

	it("never returns less than 1 even when the CPU count is degenerate", () => {
		expect(resolveAgentStartConcurrency(undefined, 0)).toBe(1);
		expect(resolveAgentStartConcurrency(undefined, -4)).toBe(1);
		expect(resolveAgentStartConcurrency(undefined, 1.5)).toBe(1);
	});
});

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function defer(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("createAgentStartLimiter", () => {
	it("never runs more than the configured concurrency at once", async () => {
		const limiter = createAgentStartLimiter(2);
		const gates = [defer(), defer(), defer(), defer()];
		let active = 0;
		let maxActive = 0;

		const runs = gates.map((gate) =>
			limiter.run(async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active -= 1;
			}),
		);

		// Let the limiter schedule the first batch.
		await Promise.resolve();
		await Promise.resolve();

		expect(limiter.concurrency).toBe(2);
		expect(limiter.activeCount).toBe(2);
		expect(limiter.pendingCount).toBe(2);

		// Release everything; the queue must drain.
		for (const gate of gates) {
			gate.resolve();
		}
		await Promise.all(runs);

		expect(maxActive).toBe(2);
		expect(limiter.activeCount).toBe(0);
		expect(limiter.pendingCount).toBe(0);
	});

	it("clamps invalid concurrency up to at least 1", () => {
		expect(createAgentStartLimiter(0).concurrency).toBe(1);
		expect(createAgentStartLimiter(-5).concurrency).toBe(1);
		expect(createAgentStartLimiter(2.7).concurrency).toBe(2);
	});

	it("propagates the wrapped function's resolved value and rejections", async () => {
		const limiter = createAgentStartLimiter(1);
		await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
		await expect(
			limiter.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});
