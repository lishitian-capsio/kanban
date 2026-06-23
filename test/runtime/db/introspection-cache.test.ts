import { describe, expect, it } from "vitest";

import { IntrospectionCache } from "../../../src/db/introspection/introspection-cache";

describe("IntrospectionCache", () => {
	it("loads on a miss and serves the cached value on a warm hit with the same signature", async () => {
		const cache = new IntrospectionCache();
		let loads = 0;
		const load = async () => {
			loads++;
			return ["a", "b"];
		};
		const first = await cache.read("conn", "schemas", async () => "sig-1", load);
		const second = await cache.read("conn", "schemas", async () => "sig-1", load);
		expect(first).toEqual(["a", "b"]);
		expect(second).toBe(first); // same reference, not re-loaded
		expect(loads).toBe(1);
	});

	it("reloads when the data signature changes (out-of-process mutation)", async () => {
		const cache = new IntrospectionCache();
		let loads = 0;
		const load = async () => {
			loads++;
			return loads;
		};
		await cache.read("conn", "schemas", async () => "sig-1", load);
		const second = await cache.read("conn", "schemas", async () => "sig-2", load);
		expect(second).toBe(2);
		expect(loads).toBe(2);
	});

	it("keeps separate entries per key and per connection", async () => {
		const cache = new IntrospectionCache();
		const loaded: string[] = [];
		const make = (label: string) => async () => {
			loaded.push(label);
			return label;
		};
		await cache.read("conn-a", "schemas", async () => "s", make("a-schemas"));
		await cache.read("conn-a", "tables:public", async () => "s", make("a-tables"));
		await cache.read("conn-b", "schemas", async () => "s", make("b-schemas"));
		// Warm hits — nothing new loaded.
		await cache.read("conn-a", "schemas", async () => "s", make("a-schemas"));
		await cache.read("conn-b", "schemas", async () => "s", make("b-schemas"));
		expect(loaded).toEqual(["a-schemas", "a-tables", "b-schemas"]);
	});

	it("invalidate() forces every key of a connection to reload on the next read", async () => {
		const cache = new IntrospectionCache();
		let loads = 0;
		const load = async () => {
			loads++;
			return loads;
		};
		// Two keys cached under the same stable data signature.
		await cache.read("conn", "schemas", async () => "stable", load);
		await cache.read("conn", "tables:public", async () => "stable", load);
		expect(loads).toBe(2);

		cache.invalidate("conn");

		// Even though the data signature is unchanged, both keys reload once.
		await cache.read("conn", "schemas", async () => "stable", load);
		await cache.read("conn", "tables:public", async () => "stable", load);
		expect(loads).toBe(4);
	});

	it("invalidate() is scoped to one connection and leaves others cached", async () => {
		const cache = new IntrospectionCache();
		let loadsA = 0;
		let loadsB = 0;
		await cache.read(
			"conn-a",
			"schemas",
			async () => "s",
			async () => ++loadsA,
		);
		await cache.read(
			"conn-b",
			"schemas",
			async () => "s",
			async () => ++loadsB,
		);

		cache.invalidate("conn-a");

		await cache.read(
			"conn-a",
			"schemas",
			async () => "s",
			async () => ++loadsA,
		);
		await cache.read(
			"conn-b",
			"schemas",
			async () => "s",
			async () => ++loadsB,
		);
		expect(loadsA).toBe(2);
		expect(loadsB).toBe(1);
	});
});
