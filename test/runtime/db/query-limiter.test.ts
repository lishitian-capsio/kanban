import { describe, expect, it } from "vitest";

import {
	createQueryConcurrencyLimiter,
	getQueryConcurrencyLimiter,
	resolveConcurrency,
} from "../../../src/db/execution/query-limiter";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resolveConcurrency", () => {
	it("falls back for absent, empty, non-numeric, or non-positive values", () => {
		expect(resolveConcurrency(undefined, 7)).toBe(7);
		expect(resolveConcurrency("", 7)).toBe(7);
		expect(resolveConcurrency("abc", 7)).toBe(7);
		expect(resolveConcurrency("0", 7)).toBe(7);
	});

	it("parses and truncates a valid value", () => {
		expect(resolveConcurrency("3", 7)).toBe(3);
		expect(resolveConcurrency("2.9", 7)).toBe(2);
	});
});

describe("createQueryConcurrencyLimiter", () => {
	it("caps total concurrency host-wide across connections", async () => {
		const limiter = createQueryConcurrencyLimiter({ hostConcurrency: 2, perConnectionConcurrency: 10 });
		let active = 0;
		let maxActive = 0;
		const gate = deferred();
		const runs = Array.from({ length: 5 }, (_, i) =>
			limiter.run(`c${i}`, async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
			}),
		);
		await tick(20);
		expect(maxActive).toBe(2);
		gate.resolve();
		await Promise.all(runs);
		expect(maxActive).toBe(2);
	});

	it("serializes queries on the same connection at the per-connection cap", async () => {
		const limiter = createQueryConcurrencyLimiter({ hostConcurrency: 10, perConnectionConcurrency: 1 });
		let active = 0;
		let maxActive = 0;
		const gate = deferred();
		const runs = [0, 1, 2].map(() =>
			limiter.run("same", async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
			}),
		);
		await tick(20);
		expect(maxActive).toBe(1);
		gate.resolve();
		await Promise.all(runs);
	});

	it("runs different connections in parallel under the per-connection cap", async () => {
		const limiter = createQueryConcurrencyLimiter({ hostConcurrency: 10, perConnectionConcurrency: 1 });
		let active = 0;
		let maxActive = 0;
		const gate = deferred();
		const runs = ["a", "b"].map((conn) =>
			limiter.run(conn, async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
			}),
		);
		await tick(20);
		expect(maxActive).toBe(2);
		gate.resolve();
		await Promise.all(runs);
	});
});

describe("getQueryConcurrencyLimiter", () => {
	it("returns a host-wide singleton", () => {
		expect(getQueryConcurrencyLimiter()).toBe(getQueryConcurrencyLimiter());
	});
});
