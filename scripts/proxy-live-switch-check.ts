#!/usr/bin/env bun
// Bun-runtime round-trip proof for live proxy switching.
//
// vitest mocks globalThis.fetch, so it can NEVER exercise Bun's real env-latch
// (the root cause this fix addresses). This runs under unmocked Bun fetch.
//
// KEY Bun facts (verified): Bun captures a proxy from the boot environment.
// `delete process.env.HTTPS_PROXY` does NOT un-latch it and `proxy:''` per
// request does not force direct — BUT assigning process.env.HTTPS_PROXY="" before
// the first fetch IS honored as "no proxy" and overrides the boot capture. The
// runtime's stripInheritedProxyEnv() does exactly that, so the holder is fully
// authoritative even when launched from a shell that exported a proxy:
// enable, switch, AND disable->direct all work, with or without an inherited proxy.
//
// This script proves it with a parent owning a "boot proxy" listener and two
// children launched with a clean vs. proxied environment; the parent asserts the
// inherited boot proxy is NEVER used (the disable path is genuinely direct).
//
// Run:  bun scripts/proxy-live-switch-check.ts   (exits non-zero on failure)

import { installProxyFetch, setRuntimeProxyState, uninstallProxyFetch } from "../src/config/proxy-fetch";

interface Listener {
	port: number;
	hits: () => number;
	stop: () => void;
}

function startListener(): Listener {
	let hits = 0;
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				hits++;
				socket.end();
			},
			data() {},
			close() {},
			error() {},
		},
	});
	return { port: (server as unknown as { port: number }).port, hits: () => hits, stop: () => server.stop(true) };
}

async function request(): Promise<void> {
	try {
		await fetch("https://nonexistent-host-xyz.invalid/", { signal: AbortSignal.timeout(2000) });
	} catch {
		// expected: the proxy listener closes us, or DNS fails for `.invalid`
	}
}

const MODE = "PROXY_LIVE_SWITCH_MODE";

async function runCleanChild(): Promise<void> {
	// Simulates the fixed runtime with a clean boot env: holder is authoritative.
	const failures: string[] = [];
	const check = (label: string, ok: boolean): void => {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
		if (!ok) failures.push(label);
	};
	installProxyFetch();
	const a = startListener();
	const b = startListener();
	try {
		setRuntimeProxyState({ enabled: true, proxyUrl: `http://127.0.0.1:${a.port}`, noProxy: "" });
		let aBefore = a.hits();
		await request();
		check("enable A -> A", a.hits() > aBefore);

		setRuntimeProxyState({ enabled: true, proxyUrl: `http://127.0.0.1:${b.port}`, noProxy: "" });
		aBefore = a.hits();
		const bBefore = b.hits();
		await request();
		check("switch A->B -> B", b.hits() > bBefore);
		check("switch A->B not A", a.hits() === aBefore);

		setRuntimeProxyState({ enabled: false, proxyUrl: "", noProxy: "" });
		aBefore = a.hits();
		const b3 = b.hits();
		await request();
		check("disable -> direct", a.hits() === aBefore && b.hits() === b3);

		setRuntimeProxyState({
			enabled: true,
			proxyUrl: `http://127.0.0.1:${a.port}`,
			noProxy: "nonexistent-host-xyz.invalid",
		});
		aBefore = a.hits();
		await request();
		check("NO_PROXY -> bypass", a.hits() === aBefore);
	} finally {
		uninstallProxyFetch();
		a.stop();
		b.stop();
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

async function runProxiedChild(): Promise<void> {
	// Inherited shell proxy at boot: stripInheritedProxyEnv()'s ""-assignment must
	// make the holder fully authoritative, including disable->direct. The parent's
	// boot listener verifies the inherited proxy is never used.
	const failures: string[] = [];
	const check = (label: string, ok: boolean): void => {
		console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
		if (!ok) failures.push(label);
	};
	installProxyFetch();
	const a = startListener();
	const b = startListener();
	try {
		setRuntimeProxyState({ enabled: true, proxyUrl: `http://127.0.0.1:${a.port}`, noProxy: "" });
		let aBefore = a.hits();
		await request();
		check("enable A overrides inherited proxy", a.hits() > aBefore);

		setRuntimeProxyState({ enabled: true, proxyUrl: `http://127.0.0.1:${b.port}`, noProxy: "" });
		const bBefore = b.hits();
		await request();
		check("switch to B overrides inherited proxy", b.hits() > bBefore);

		setRuntimeProxyState({ enabled: false, proxyUrl: "", noProxy: "" });
		aBefore = a.hits();
		const b3 = b.hits();
		await request();
		check("disable -> direct (not the inherited proxy)", a.hits() === aBefore && b.hits() === b3);
	} finally {
		uninstallProxyFetch();
		a.stop();
		b.stop();
	}
	process.exit(failures.length > 0 ? 1 : 0);
}

async function spawnChild(mode: string, extraEnv: Record<string, string | undefined>): Promise<number> {
	const env: Record<string, string | undefined> = { ...process.env, [MODE]: mode, ...extraEnv };
	const child = Bun.spawn(["bun", import.meta.path], { env, stdout: "inherit", stderr: "inherit" });
	return await child.exited;
}

async function runParent(): Promise<void> {
	let failed = false;

	console.log("clean boot env (fixed runtime): full live lifecycle");
	// Force a clean env regardless of how CI launched us.
	const cleanCode = await spawnChild("clean", {
		HTTP_PROXY: undefined,
		HTTPS_PROXY: undefined,
		http_proxy: undefined,
		https_proxy: undefined,
	});
	if (cleanCode !== 0) failed = true;

	console.log("\ninherited shell proxy at boot: holder fully authoritative");
	const boot = startListener();
	const proxiedCode = await spawnChild("proxied", {
		https_proxy: `http://127.0.0.1:${boot.port}`,
		HTTPS_PROXY: `http://127.0.0.1:${boot.port}`,
	});
	const bootHits = boot.hits();
	boot.stop();
	console.log(`  ${bootHits === 0 ? "PASS" : "FAIL"}  inherited boot proxy was NEVER used (latch overridden)`);
	if (proxiedCode !== 0 || bootHits !== 0) failed = true;

	if (failed) {
		console.error("\nproxy live-switch check FAILED");
		process.exit(1);
	}
	console.log("\nAll proxy live-switch checks passed.");
}

const mode = process.env[MODE];
if (mode === "clean") {
	await runCleanChild();
} else if (mode === "proxied") {
	await runProxiedChild();
} else {
	await runParent();
}
