import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../../../src/core/runtime-endpoint";
import {
	buildAllowedHostHeaders,
	buildAllowedOrigins,
	evaluateCors,
	evaluateHost,
	getAllowedHostHeaders,
	getAllowedOrigins,
	handleSocketUpgrade,
} from "../../../src/server/middleware";

const ALLOWED_ORIGIN = "http://127.0.0.1:3484";
const ALLOWED_ORIGINS = new Set(["http://localhost:3484", "http://127.0.0.1:3484"]);
const ALLOWED_HOSTS = new Set(["localhost:3484", "127.0.0.1:3484"]);

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

describe("evaluateCors", () => {
	it("allows requests with no Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests with an empty Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin matches an allowed origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: ALLOWED_ORIGIN });
	});

	it("allows any origin present in the allowlist (LAN IP origin)", () => {
		const allowed = new Set(["http://127.0.0.1:3484", "http://192.168.50.203:3484"]);
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://192.168.50.203:3484",
			allowedOrigins: allowed,
		});
		expect(decision).toEqual({ kind: "allow", origin: "http://192.168.50.203:3484" });
	});

	it("matches the Origin case-insensitively but echoes the original", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "HTTP://127.0.0.1:3484",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: "HTTP://127.0.0.1:3484" });
	});

	it("rejects requests from a different origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("rejects requests from the same host but a different port", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "http://127.0.0.1:9999",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://127.0.0.1:9999" });
	});

	it("rejects requests from the same host but a different scheme", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "https://127.0.0.1:3484",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "https://127.0.0.1:3484" });
	});

	it("returns a preflight decision for OPTIONS from an allowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "preflight", origin: ALLOWED_ORIGIN });
	});

	it("rejects preflight from a disallowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("allows OPTIONS without an Origin header (not a CORS preflight)", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});
});

describe("evaluateHost", () => {
	it("rejects requests with no Host header", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: null,
		});
	});

	it("rejects requests with an empty Host header", () => {
		expect(evaluateHost({ hostHeader: "", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "reject", host: null });
	});

	it("allows requests whose Host is in the allowlist", () => {
		expect(evaluateHost({ hostHeader: "127.0.0.1:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
		expect(evaluateHost({ hostHeader: "localhost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("normalises Host header casing before comparing", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("rejects DNS rebinding attempts via a foreign Host header", () => {
		expect(evaluateHost({ hostHeader: "attacker.example.com:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3484",
		});
	});

	it("rejects when the port doesn't match", () => {
		expect(evaluateHost({ hostHeader: "localhost:9999", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "localhost:9999",
		});
	});
});

describe("buildAllowedHostHeaders", () => {
	const base = { port: 3484, isDev: false, localNetworkHosts: [], configuredHosts: [] };

	it("allows only the loopback aliases for a loopback bind", () => {
		const allowed = buildAllowedHostHeaders({ ...base, boundHost: "127.0.0.1" });
		expect([...allowed].sort()).toEqual(["127.0.0.1:3484", "localhost:3484"]);
	});

	it("keeps the loopback aliases reachable when bound to a concrete LAN IP", () => {
		const allowed = buildAllowedHostHeaders({ ...base, boundHost: "192.168.50.203" });
		expect(allowed.has("localhost:3484")).toBe(true);
		expect(allowed.has("127.0.0.1:3484")).toBe(true);
		expect(allowed.has("192.168.50.203:3484")).toBe(true);
	});

	it("enumerates the local NIC IPs for a 0.0.0.0 wildcard bind instead of the literal 0.0.0.0", () => {
		const allowed = buildAllowedHostHeaders({
			...base,
			boundHost: "0.0.0.0",
			localNetworkHosts: ["192.168.50.203", "10.0.0.5"],
		});
		expect(allowed.has("0.0.0.0:3484")).toBe(false);
		expect(allowed.has("localhost:3484")).toBe(true);
		expect(allowed.has("127.0.0.1:3484")).toBe(true);
		expect(allowed.has("192.168.50.203:3484")).toBe(true);
		expect(allowed.has("10.0.0.5:3484")).toBe(true);
	});

	it("brackets IPv6 NIC addresses for a :: wildcard bind", () => {
		const allowed = buildAllowedHostHeaders({
			...base,
			boundHost: "::",
			localNetworkHosts: ["fd00::1"],
		});
		expect(allowed.has("[::]:3484")).toBe(false);
		expect(allowed.has("[fd00::1]:3484")).toBe(true);
	});

	it("includes operator-configured extra hosts (domains)", () => {
		const allowed = buildAllowedHostHeaders({
			...base,
			boundHost: "192.168.50.203",
			configuredHosts: ["board.example.com"],
		});
		expect(allowed.has("board.example.com:3484")).toBe(true);
	});

	it("adds the Vite dev-server host:port in dev mode", () => {
		const allowed = buildAllowedHostHeaders({ ...base, boundHost: "127.0.0.1", isDev: true });
		expect(allowed.has("localhost:4173")).toBe(true);
		expect(allowed.has("127.0.0.1:4173")).toBe(true);
	});
});

describe("buildAllowedOrigins", () => {
	it("prefixes each allowed host:port with the runtime scheme", () => {
		const origins = buildAllowedOrigins(new Set(["localhost:3484", "192.168.50.203:3484"]), "http");
		expect([...origins].sort()).toEqual(["http://192.168.50.203:3484", "http://localhost:3484"]);
	});

	it("uses the https scheme when TLS is enabled", () => {
		const origins = buildAllowedOrigins(new Set(["192.168.50.203:3484"]), "https");
		expect(origins.has("https://192.168.50.203:3484")).toBe(true);
	});
});

describe("getAllowedHostHeaders / getAllowedOrigins wiring", () => {
	const originalHost = getKanbanRuntimeHost();
	const originalPort = getKanbanRuntimePort();

	afterEach(() => {
		setKanbanRuntimeHost(originalHost);
		setKanbanRuntimePort(originalPort);
	});

	it("never self-locks a 0.0.0.0 wildcard bind: loopback stays allowed and 0.0.0.0 is not the only host", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimePort(3484);
		const hosts = getAllowedHostHeaders();
		expect(hosts.has("localhost:3484")).toBe(true);
		expect(hosts.has("127.0.0.1:3484")).toBe(true);
		expect(hosts.has("0.0.0.0:3484")).toBe(false);

		const origins = getAllowedOrigins();
		expect(origins.has("http://localhost:3484")).toBe(true);
		expect(origins.has("http://0.0.0.0:3484")).toBe(false);
	});

	it("retains the loopback aliases when bound to a concrete LAN IP", () => {
		setKanbanRuntimeHost("192.168.50.203");
		setKanbanRuntimePort(3484);
		const hosts = getAllowedHostHeaders();
		expect(hosts.has("localhost:3484")).toBe(true);
		expect(hosts.has("192.168.50.203:3484")).toBe(true);
		expect(getAllowedOrigins().has("http://192.168.50.203:3484")).toBe(true);
	});
});

describe("handleSocketUpgrade", () => {
	it("passes through upgrades whose Host and Origin are both allowed", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from a disallowed origin with a 403 status line", () => {
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk) => {
			written.push(chunk as Buffer);
		});
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: "http://evil.example.com" });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
		expect(Buffer.concat(written).toString("utf8")).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades whose Host header doesn't match the allowlist", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "attacker.example.com:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});

	it("rejects upgrades with a missing Host header", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});
});
