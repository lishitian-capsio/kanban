import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { request as httpRequest } from "node:http";

// Mock the proxy state holder so we can control what the bridge sees.
const proxyStateMocks = vi.hoisted(() => ({
	getRuntimeProxyState: vi.fn(),
}));

vi.mock("../../../src/config/proxy-fetch", () => ({
	getRuntimeProxyState: proxyStateMocks.getRuntimeProxyState,
}));

// Mock proxy-env helpers used by the bridge.
vi.mock("../../../src/config/proxy-env", () => ({
	shouldBypassProxy: (host: string, noProxy: string): boolean => {
		if (!noProxy) return false;
		const entries = noProxy.split(",").map((s) => s.trim().toLowerCase());
		return entries.includes(host.toLowerCase());
	},
	LOOPBACK_NO_PROXY_HOSTS: ["localhost", "127.0.0.1", "::1"],
}));

import {
	startNetworkBridge,
	stopNetworkBridge,
	getNetworkBridge,
	buildBridgeProxyEnvVars,
} from "../../../src/unified-proxy/network-bridge";

function httpGet(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parseInt(parsed.port, 10),
				path: parsed.pathname + parsed.search,
				method: "GET",
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk.toString()));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

// Send a request through the bridge as a forward proxy (full URL in request line).
function httpGetViaProxy(proxyUrl: string, targetUrl: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(proxyUrl);
		const req = httpRequest(
			{
				hostname: parsed.hostname,
				port: parseInt(parsed.port, 10),
				path: targetUrl, // Full URL = proxy mode
				method: "GET",
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk.toString()));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

describe("network-bridge", () => {
	let targetServer: Server | null = null;
	let targetPort = 0;

	beforeEach(() => {
		proxyStateMocks.getRuntimeProxyState.mockReset();
		proxyStateMocks.getRuntimeProxyState.mockReturnValue({
			enabled: false,
			proxyUrl: "",
			noProxy: "",
		});
	});

	afterEach(async () => {
		await stopNetworkBridge();
		if (targetServer) {
			await new Promise<void>((resolve) => targetServer!.close(() => resolve()));
			targetServer = null;
		}
	});

	function startTargetServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<number> {
		return new Promise<number>((resolve) => {
			targetServer = createServer(handler);
			targetServer.listen(0, "127.0.0.1", () => {
				const addr = targetServer!.address();
				targetPort = typeof addr === "object" && addr !== null ? addr.port : 0;
				resolve(targetPort);
			});
		});
	}

	it("starts on an ephemeral port and returns the URL", () => {
		const bridge = startNetworkBridge();
		expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(bridge.port).toBeGreaterThan(0);
	});

	it("is idempotent — calling startNetworkBridge twice returns the same handle", () => {
		const a = startNetworkBridge();
		const b = startNetworkBridge();
		expect(a.url).toBe(b.url);
		expect(a.port).toBe(b.port);
	});

	it("getNetworkBridge returns the current handle", () => {
		expect(getNetworkBridge()).toBeNull();
		const bridge = startNetworkBridge();
		expect(getNetworkBridge()).toBe(bridge);
	});

	it("buildBridgeProxyEnvVars returns correct env vars", () => {
		const bridge = startNetworkBridge();
		const vars = buildBridgeProxyEnvVars();
		expect(vars.HTTP_PROXY).toBe(bridge.url);
		expect(vars.HTTPS_PROXY).toBe(bridge.url);
		expect(vars.http_proxy).toBe(bridge.url);
		expect(vars.https_proxy).toBe(bridge.url);
		expect(vars.NO_PROXY).toContain("localhost");
	});

	it("buildBridgeProxyEnvVars returns empty when bridge is not started", async () => {
		// Bridge is stopped in afterEach, so just verify directly.
		const vars = buildBridgeProxyEnvVars();
		expect(vars).toEqual({});
	});

	it("forwards HTTP requests directly when proxy is disabled", async () => {
		const port = await startTargetServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("hello from target");
		});

		const bridge = startNetworkBridge();
		const response = await httpGetViaProxy(bridge.url, `http://127.0.0.1:${port}/test`);
		expect(response.status).toBe(200);
		expect(response.body).toBe("hello from target");
	});

	it("reads proxy state dynamically on each request", async () => {
		let requestCount = 0;
		const port = await startTargetServer((_req, res) => {
			requestCount++;
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end(`request-${requestCount}`);
		});

		// First request: proxy disabled → direct.
		proxyStateMocks.getRuntimeProxyState.mockReturnValue({
			enabled: false,
			proxyUrl: "",
			noProxy: "",
		});

		const bridge = startNetworkBridge();
		const r1 = await httpGetViaProxy(bridge.url, `http://127.0.0.1:${port}/test`);
		expect(r1.status).toBe(200);
		expect(r1.body).toBe("request-1");

		// Second request: still direct but state is re-read.
		const r2 = await httpGetViaProxy(bridge.url, `http://127.0.0.1:${port}/test`);
		expect(r2.status).toBe(200);
		expect(r2.body).toBe("request-2");

		// Verify getRuntimeProxyState was called for each request.
		expect(proxyStateMocks.getRuntimeProxyState.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("stops cleanly and releases the port", async () => {
		const bridge = startNetworkBridge();
		const port = bridge.port;
		await stopNetworkBridge();

		expect(getNetworkBridge()).toBeNull();

		// Starting a new bridge should work (port is free or a new one is assigned).
		const bridge2 = startNetworkBridge();
		expect(bridge2.port).toBeGreaterThan(0);
	});
});
