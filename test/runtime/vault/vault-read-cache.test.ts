import { describe, expect, it, vi } from "vitest";

import type { RuntimeVaultDocument } from "../../../src/core/api-contract";
import { getVaultReadCache, VaultReadCache } from "../../../src/vault/vault-read-cache";

function doc(id: string, title = id): RuntimeVaultDocument {
	return {
		id,
		type: "note",
		title,
		body: "",
		frontmatter: {},
		relativePath: `docs/note/${id}.md`,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("VaultReadCache.read", () => {
	it("serves cached documents without re-scanning while the signature is unchanged", async () => {
		const cache = new VaultReadCache();
		const scan = vi.fn(async () => ({ documents: [doc("a")], signature: "sig-1" }));
		const computeSignature = vi.fn(async () => "sig-1");

		const first = await cache.read({ computeSignature, scan });
		const second = await cache.read({ computeSignature, scan });

		expect(first.documents).toEqual([doc("a")]);
		expect(second.documents).toEqual([doc("a")]);
		expect(second.version).toBe(first.version);
		// The expensive scan ran exactly once; the cheap signature probe gated the second read.
		expect(scan).toHaveBeenCalledTimes(1);
		expect(computeSignature).toHaveBeenCalledTimes(1);
	});

	it("re-scans and bumps the version when the signature changes", async () => {
		const cache = new VaultReadCache();
		let signature = "sig-1";
		let documents = [doc("a")];
		const scan = vi.fn(async () => ({ documents, signature }));
		const computeSignature = vi.fn(async () => signature);

		const first = await cache.read({ computeSignature, scan });

		// An external edit changes the on-disk signature and content.
		signature = "sig-2";
		documents = [doc("a"), doc("b")];

		const second = await cache.read({ computeSignature, scan });

		expect(first.documents).toHaveLength(1);
		expect(second.documents).toHaveLength(2);
		expect(second.version).toBeGreaterThan(first.version);
		expect(scan).toHaveBeenCalledTimes(2);
	});

	it("re-scans on the next read after invalidate(), bypassing the signature probe", async () => {
		const cache = new VaultReadCache();
		const computeSignature = vi.fn(async () => "sig-stable");
		const scan = vi.fn(async () => ({ documents: [doc("a")], signature: "sig-stable" }));

		await cache.read({ computeSignature, scan });
		cache.invalidate();
		const after = await cache.read({ computeSignature, scan });

		expect(scan).toHaveBeenCalledTimes(2);
		expect(after.version).toBe(2);
		// invalidate() must not even bother probing the signature on the forced read.
		expect(computeSignature).toHaveBeenCalledTimes(0);
	});
});

describe("VaultReadCache.derive", () => {
	it("builds a derived structure once per version and rebuilds when the version changes", async () => {
		const cache = new VaultReadCache();
		let signature = "sig-1";
		const scan = vi.fn(async () => ({ documents: [doc("a")], signature }));
		const computeSignature = vi.fn(async () => signature);
		const build = vi.fn((docs: RuntimeVaultDocument[]) => docs.map((d) => d.id));

		const r1 = await cache.read({ computeSignature, scan });
		const d1 = cache.derive("ids", r1.version, () => build(r1.documents));
		const d2 = cache.derive("ids", r1.version, () => build(r1.documents));
		expect(d1).toEqual(["a"]);
		expect(d2).toBe(d1); // same reference: not rebuilt at the same version
		expect(build).toHaveBeenCalledTimes(1);

		signature = "sig-2";
		const r2 = await cache.read({ computeSignature, scan });
		cache.derive("ids", r2.version, () => build(r2.documents));
		expect(build).toHaveBeenCalledTimes(2); // rebuilt after the version bumped
	});
});

describe("getVaultReadCache", () => {
	it("returns one shared cache per key and isolates distinct keys", () => {
		const a1 = getVaultReadCache("/repo/a");
		const a2 = getVaultReadCache("/repo/a");
		const b = getVaultReadCache("/repo/b");

		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
	});
});
