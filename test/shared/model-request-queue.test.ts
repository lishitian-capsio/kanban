import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModelRequestQueue } from "../../src/agent-sdk/shared/model-request-queue";

describe("ModelRequestQueue", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Mock Math.random to return predictable values for jitter
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("executes requests sequentially with spacing", async () => {
		const queue = new ModelRequestQueue({ minDelayMs: 1000, maxDelayMs: 60000 });
		const results: number[] = [];

		const p1 = queue.enqueue(async () => {
			results.push(1);
			return 1;
		});

		const p2 = queue.enqueue(async () => {
			results.push(2);
			return 2;
		});

		// First request starts immediately
		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(results).toEqual([1]);

		// Second request waits for minDelayMs spacing
		await vi.advanceTimersByTimeAsync(1000);
		await p2;
		expect(results).toEqual([1, 2]);
	});

	it("applies exponential backoff on failures", async () => {
		const queue = new ModelRequestQueue({ minDelayMs: 1000, maxDelayMs: 60000 });
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error("Temporary failure");
			}
			return "success";
		});

		// First attempt - immediate
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		// First retry after 1s (2^0 * 1000)
		await vi.advanceTimersByTimeAsync(1000);
		expect(attempts).toBe(2);

		// Second retry after 2s (2^1 * 1000)
		await vi.advanceTimersByTimeAsync(2000);
		expect(attempts).toBe(3);

		const result = await promise;
		expect(result).toBe("success");
	});

	it("respects maxDelayMs cap", async () => {
		const queue = new ModelRequestQueue({ minDelayMs: 1000, maxDelayMs: 5000 });
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 5) {
				throw new Error("Failure");
			}
			return "done";
		});

		// Attempt 1: immediate
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		// Attempt 2: 1s delay (2^0 * 1000)
		await vi.advanceTimersByTimeAsync(1000);
		expect(attempts).toBe(2);

		// Attempt 3: 2s delay (2^1 * 1000)
		await vi.advanceTimersByTimeAsync(2000);
		expect(attempts).toBe(3);

		// Attempt 4: 4s delay (2^2 * 1000)
		await vi.advanceTimersByTimeAsync(4000);
		expect(attempts).toBe(4);

		// Attempt 5: capped at 5s (not 8s)
		await vi.advanceTimersByTimeAsync(5000);
		expect(attempts).toBe(5);

		const result = await promise;
		expect(result).toBe("done");
	});

	it("uses capacity-aware backoff for 503 errors", async () => {
		const queue = new ModelRequestQueue({
			minDelayMs: 1000,
			maxDelayMs: 60000,
			capacityBaseDelayMs: 10000,
		});
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 3) {
				const error = new Error("503 Service Unavailable");
				(error as any).status = 503;
				throw error;
			}
			return "recovered";
		});

		// Attempt 1: immediate
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		// Attempt 2: ~10s delay (capacity base with jitter 0.5-1.5x, mocked to 1.0x)
		await vi.advanceTimersByTimeAsync(10000);
		expect(attempts).toBe(2);

		// Attempt 3: ~20s delay (2^1 * 10000 with jitter)
		await vi.advanceTimersByTimeAsync(20000);
		expect(attempts).toBe(3);

		const result = await promise;
		expect(result).toBe("recovered");
	});

	it("uses capacity-aware backoff for 429 errors", async () => {
		const queue = new ModelRequestQueue({
			minDelayMs: 1000,
			maxDelayMs: 60000,
			capacityBaseDelayMs: 10000,
		});
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 2) {
				const error = new Error("429 Too Many Requests");
				(error as any).status = 429;
				throw error;
			}
			return "ok";
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		await vi.advanceTimersByTimeAsync(10000);
		expect(attempts).toBe(2);

		const result = await promise;
		expect(result).toBe("ok");
	});

	it("uses capacity-aware backoff for 529 errors", async () => {
		const queue = new ModelRequestQueue({
			minDelayMs: 1000,
			maxDelayMs: 60000,
			capacityBaseDelayMs: 10000,
		});
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 2) {
				const error = new Error("529 Overloaded");
				(error as any).status = 529;
				throw error;
			}
			return "ok";
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		await vi.advanceTimersByTimeAsync(10000);
		expect(attempts).toBe(2);

		const result = await promise;
		expect(result).toBe("ok");
	});

	it("uses capacity-aware backoff for capacity-related error messages", async () => {
		const queue = new ModelRequestQueue({
			minDelayMs: 1000,
			maxDelayMs: 60000,
			capacityBaseDelayMs: 10000,
		});
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			if (attempts < 2) {
				throw new Error("System capacity limit reached");
			}
			return "ok";
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		await vi.advanceTimersByTimeAsync(10000);
		expect(attempts).toBe(2);

		const result = await promise;
		expect(result).toBe("ok");
	});

	it("gives up after maxRetries", async () => {
		const queue = new ModelRequestQueue({
			minDelayMs: 100,
			maxDelayMs: 1000,
			maxRetries: 2,
		});
		let attempts = 0;

		const promise = queue.enqueue(async () => {
			attempts++;
			throw new Error("Always fails");
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);

		await vi.advanceTimersByTimeAsync(100);
		expect(attempts).toBe(2);

		await vi.advanceTimersByTimeAsync(200);
		expect(attempts).toBe(3);

		await expect(promise).rejects.toThrow("Always fails");
	});

	it("handles concurrent enqueue calls correctly", async () => {
		const queue = new ModelRequestQueue({ minDelayMs: 1000, maxDelayMs: 60000 });
		const results: number[] = [];

		// Enqueue 3 requests simultaneously
		const p1 = queue.enqueue(async () => {
			results.push(1);
			return 1;
		});

		const p2 = queue.enqueue(async () => {
			results.push(2);
			return 2;
		});

		const p3 = queue.enqueue(async () => {
			results.push(3);
			return 3;
		});

		// First starts immediately
		await vi.advanceTimersByTimeAsync(0);
		await p1;
		expect(results).toEqual([1]);

		// Second after 1s delay
		await vi.advanceTimersByTimeAsync(1000);
		await p2;
		expect(results).toEqual([1, 2]);

		// Third after another 1s delay
		await vi.advanceTimersByTimeAsync(1000);
		await p3;
		expect(results).toEqual([1, 2, 3]);
	});
});
