// Lightweight forward proxy (HTTP + CONNECT) for CLI agent sessions.
//
// Purpose: solves the "Network Proxy not live-updatable for CLI agents" problem.
// CLI agents receive HTTP_PROXY at spawn time, which is immutable after that.
// By pointing HTTP_PROXY at this local bridge, and having the bridge read the
// RuntimeProxyState holder on every request, config changes take effect on the
// very next request without restarting the session.
//
// Architecture:
//   CLI agent → HTTP_PROXY=127.0.0.1:<port> → this bridge → outbound proxy or direct
//
// The bridge reads getRuntimeProxyState() on each request. It does NOT cache
// the proxy config — the holder is the single source of truth.
//
// In-process requests (Pi, OAuth, etc.) continue to use installProxyFetch()
// which already has immediate-effect via the same holder. This bridge only
// serves subprocess traffic.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { getRuntimeProxyState, type RuntimeProxyState } from "../config/proxy-fetch";
import { shouldBypassProxy, LOOPBACK_NO_PROXY_HOSTS } from "../config/proxy-env";

// ------------------------------------------------------------------ types

export interface NetworkBridgeHandle {
	/** The local URL of the bridge (e.g. "http://127.0.0.1:54321"). */
	url: string;
	/** The port the bridge is listening on. */
	port: number;
	/** Stop the bridge server. */
	close(): Promise<void>;
}

// ------------------------------------------------------------------ helpers

function parseHostPort(url: string | undefined): { host: string; port: number } {
	if (!url) return { host: "localhost", port: 443 };
	const match = url.match(/^(.+?):(\d+)$/);
	if (match) return { host: match[1], port: parseInt(match[2], 10) };
	return { host: url, port: 443 };
}

function buildNoProxyList(state: RuntimeProxyState): string {
	// Always include loopback hosts so the bridge never proxies its own traffic.
	const loopback = LOOPBACK_NO_PROXY_HOSTS.join(",");
	return state.noProxy ? `${state.noProxy},${loopback}` : loopback;
}

function shouldUseProxy(host: string, state: RuntimeProxyState): boolean {
	if (!state.enabled || !state.proxyUrl) return false;
	const noProxy = buildNoProxyList(state);
	return !shouldBypassProxy(host, noProxy);
}

// ------------------------------------------------------------------ HTTP forwarding

/**
 * Forward a plain HTTP request (not CONNECT). The client sends the full URL
 * in the request line (standard HTTP proxy behavior).
 */
function forwardHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	state: RuntimeProxyState,
): void {
	const targetUrl = req.url;
	if (!targetUrl) {
		res.writeHead(400);
		res.end("Bad Request: no URL");
		return;
	}

	let parsed: URL;
	try {
		parsed = new URL(targetUrl);
	} catch {
		res.writeHead(400);
		res.end("Bad Request: invalid URL");
		return;
	}

	const useProxy = shouldUseProxy(parsed.hostname, state);

	// Forward the request body through to the target (or via outbound proxy).
	const headers = { ...req.headers };
	delete headers["proxy-connection"];
	delete headers["proxy-authorization"];

	const options: Record<string, unknown> = {
		method: req.method,
		headers,
	};

	if (useProxy && state.proxyUrl) {
		// Route through the outbound proxy.
		const proxyUrl = new URL(state.proxyUrl);
		options.hostname = proxyUrl.hostname;
		options.port = parseInt(proxyUrl.port || "80", 10);
		options.path = targetUrl; // Full URL for HTTP proxy

		// Proxy auth
		if (proxyUrl.username) {
			const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || "")}`;
			(options.headers as Record<string, string>)["Proxy-Authorization"] =
				`Basic ${Buffer.from(auth).toString("base64")}`;
		}
	} else {
		// Direct connection.
		options.hostname = parsed.hostname;
		options.port = parseInt(parsed.port || "80", 10);
		options.path = parsed.pathname + parsed.search;
	}

	// Use Node's http.request for forwarding (preserves original request
	// semantics, avoids Bun fetch latch issues).
	const proxyReq = httpRequest(options, (proxyRes) => {
		res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
		proxyRes.pipe(res, { end: true });
	});

	proxyReq.on("error", (err) => {
		if (!res.headersSent) {
			res.writeHead(502);
		}
		res.end(`Proxy Error: ${err.message}`);
	});

	req.pipe(proxyReq, { end: true });
}

// ------------------------------------------------------------------ CONNECT tunnel

/**
 * Handle a CONNECT request by establishing a TCP tunnel between the client
 * and the target host. The tunnel either goes direct or through the outbound
 * proxy (via another CONNECT).
 */
function handleConnect(
	req: IncomingMessage,
	clientSocket: Socket,
	head: Buffer,
	state: RuntimeProxyState,
): void {
	const { host, port } = parseHostPort(req.url);
	const useProxy = shouldUseProxy(host, state);

	const onTunnelReady = (serverSocket: Socket): void => {
		clientSocket.write(
			"HTTP/1.1 200 Connection Established\r\n\r\n",
		);

		// Write any buffered data from the client.
		if (head.length > 0) serverSocket.write(head);

		// Bidirectional pipe.
		serverSocket.pipe(clientSocket);
		clientSocket.pipe(serverSocket);

		serverSocket.on("error", () => clientSocket.destroy());
		clientSocket.on("error", () => serverSocket.destroy());
	};

	if (useProxy && state.proxyUrl) {
		// Tunnel through the outbound proxy using CONNECT.
		const proxyUrl = new URL(state.proxyUrl);
		const proxyHost = proxyUrl.hostname;
		const proxyPort = parseInt(proxyUrl.port || "80", 10);

		const proxySocket = netConnect({ host: proxyHost, port: proxyPort });

		proxySocket.on("connect", () => {
			let connectHeaders = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
			if (proxyUrl.username) {
				const auth = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || "")}`;
				connectHeaders += `Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n`;
			}
			connectHeaders += "\r\n";
			proxySocket.write(connectHeaders);
		});

		// Wait for the proxy to respond with 200 before piping.
		let responseData = Buffer.alloc(0);
		proxySocket.on("data", function onData(chunk: Buffer) {
			responseData = Buffer.concat([responseData, chunk]);
			const headerEnd = responseData.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;

			proxySocket.removeListener("data", onData);
			const statusLine = responseData.subarray(0, responseData.indexOf("\r\n")).toString();
			const remaining = responseData.subarray(headerEnd + 4);

			if (!statusLine.includes(" 200 ")) {
				clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
				clientSocket.destroy();
				proxySocket.destroy();
				return;
			}

			// Proxy CONNECT established. Pipe client ↔ proxy.
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) proxySocket.write(head);
			if (remaining.length > 0) proxySocket.write(remaining);

			proxySocket.pipe(clientSocket);
			clientSocket.pipe(proxySocket);

			proxySocket.on("error", () => clientSocket.destroy());
			clientSocket.on("error", () => proxySocket.destroy());
		});

		proxySocket.on("error", () => {
			clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			clientSocket.destroy();
		});
	} else {
		// Direct TCP connection to target.
		const serverSocket = netConnect({ host, port });
		serverSocket.on("connect", () => onTunnelReady(serverSocket));
		serverSocket.on("error", () => {
			clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			clientSocket.destroy();
		});
	}
}

// ------------------------------------------------------------------ public API

let bridgeInstance: NetworkBridgeHandle | null = null;

/**
 * Start the network bridge proxy server. Binds to 127.0.0.1 on an ephemeral
 * port. Returns a handle with the URL to inject into subprocess HTTP_PROXY.
 *
 * Idempotent — calling multiple times returns the same handle.
 */
export function startNetworkBridge(): NetworkBridgeHandle {
	if (bridgeInstance) return bridgeInstance;

	const server = createServer((req, res) => {
		// All plain HTTP requests go through the forward handler.
		const state = getRuntimeProxyState();
		forwardHttpRequest(req, res, state);
	});

	server.on("connect", (req, socket, head) => {
		const state = getRuntimeProxyState();
		handleConnect(req, socket as Socket, head as Buffer, state);
	});

	// Bind to loopback only — the bridge is not a public-facing service.
	server.listen(0, "127.0.0.1");

	const addr = server.address();
	const port = typeof addr === "object" && addr !== null ? addr.port : 0;
	const url = `http://127.0.0.1:${port}`;

	bridgeInstance = {
		url,
		port,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			bridgeInstance = null;
		},
	};

	return bridgeInstance;
}

/**
 * Get the current bridge handle, or null if not started.
 */
export function getNetworkBridge(): NetworkBridgeHandle | null {
	return bridgeInstance;
}

/**
 * Stop the network bridge if running.
 */
export async function stopNetworkBridge(): Promise<void> {
	if (bridgeInstance) {
		await bridgeInstance.close();
	}
}

/**
 * Build HTTP_PROXY env vars pointing to the network bridge.
 * Returns `{}` if the bridge is not started.
 *
 * Use this instead of buildProxyEnvVars for CLI agent sessions. The bridge
 * URL is fixed (set at startup), but the bridge itself reads the latest
 * RuntimeProxyState on every request — so proxy config changes take effect
 * immediately without restarting the session.
 */
export function buildBridgeProxyEnvVars(): Record<string, string> {
	if (!bridgeInstance) return {};
	const url = bridgeInstance.url;
	return {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		http_proxy: url,
		https_proxy: url,
		// All local services bypass the bridge (Kanban server, auth-gateway, etc.)
		NO_PROXY: "localhost,127.0.0.1,::1",
		no_proxy: "localhost,127.0.0.1,::1",
	};
}
