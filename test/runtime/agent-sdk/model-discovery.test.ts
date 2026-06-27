import { describe, expect, it } from "vitest";
import {
	buildModelsUrl,
	classifyModelFetchError,
	extractModelRecords,
} from "../../../src/agent-sdk/kanban/model-discovery";

describe("buildModelsUrl", () => {
	it("appends /models for OpenAI-compatible bases", () => {
		expect(buildModelsUrl("https://api.openai.com/v1", "openai")).toBe("https://api.openai.com/v1/models");
	});

	it("normalizes trailing slashes", () => {
		expect(buildModelsUrl("https://api.openai.com/v1/", "openai")).toBe("https://api.openai.com/v1/models");
		expect(buildModelsUrl("https://api.openai.com/v1///", "openai")).toBe("https://api.openai.com/v1/models");
	});

	it("trims surrounding whitespace", () => {
		expect(buildModelsUrl("  https://api.openai.com/v1  ", "openai")).toBe("https://api.openai.com/v1/models");
	});

	it("appends /v1/models for an Anthropic base without a version segment", () => {
		expect(buildModelsUrl("https://api.anthropic.com", "anthropic")).toBe("https://api.anthropic.com/v1/models");
	});

	it("does not double the version segment when an Anthropic base already ends in /v1", () => {
		expect(buildModelsUrl("https://api.anthropic.com/v1", "anthropic")).toBe("https://api.anthropic.com/v1/models");
		expect(buildModelsUrl("https://api.anthropic.com/v1/", "anthropic")).toBe("https://api.anthropic.com/v1/models");
	});

	it("supports local OpenAI-compatible servers (e.g. Ollama)", () => {
		expect(buildModelsUrl("http://localhost:11434/v1", "openai")).toBe("http://localhost:11434/v1/models");
	});
});

describe("extractModelRecords", () => {
	it("reads the OpenAI { data: [...] } shape", () => {
		expect(extractModelRecords({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] })).toEqual([
			{ id: "gpt-4o", name: undefined },
			{ id: "gpt-4o-mini", name: undefined },
		]);
	});

	it("reads the { models: [...] } shape with names", () => {
		expect(extractModelRecords({ models: [{ id: "m1", name: "Model One" }] })).toEqual([
			{ id: "m1", name: "Model One" },
		]);
	});

	it("reads a top-level array", () => {
		expect(extractModelRecords([{ id: "a" }, { id: "b" }])).toEqual([
			{ id: "a", name: undefined },
			{ id: "b", name: undefined },
		]);
	});

	it("drops entries without a usable id and trims", () => {
		expect(extractModelRecords({ data: [{ id: " keep " }, { name: "no-id" }, {}, null, "x"] })).toEqual([
			{ id: "keep", name: undefined },
		]);
	});

	it("returns [] for unexpected payloads", () => {
		expect(extractModelRecords(null)).toEqual([]);
		expect(extractModelRecords("nope")).toEqual([]);
		expect(extractModelRecords({ foo: "bar" })).toEqual([]);
	});
});

describe("classifyModelFetchError", () => {
	const url = "https://api.example.com/v1/models";

	it("maps 401/403 to an auth message", () => {
		expect(classifyModelFetchError({ url, status: 401 })).toMatch(/Authentication failed \(HTTP 401\)/);
		expect(classifyModelFetchError({ url, status: 403 })).toMatch(/Authentication failed \(HTTP 403\)/);
	});

	it("maps 404 to a base-url/protocol hint", () => {
		expect(classifyModelFetchError({ url, status: 404 })).toMatch(/not found \(HTTP 404\).*base URL/);
	});

	it("maps 429 to a rate-limit message", () => {
		expect(classifyModelFetchError({ url, status: 429 })).toMatch(/Rate limited/);
	});

	it("maps other HTTP statuses generically", () => {
		expect(classifyModelFetchError({ url, status: 502, statusText: "Bad Gateway" })).toMatch(/HTTP 502 Bad Gateway/);
	});

	it("maps Bun's connection-refused message to a clear host/port hint", () => {
		const msg = classifyModelFetchError({
			url,
			error: Object.assign(
				new Error(
					"Unable to connect. Is the computer able to access the url? Was there a typo in the url or port?",
				),
				{
					code: "ConnectionRefused",
				},
			),
		});
		expect(msg).toMatch(/Connection refused at api\.example\.com/);
		expect(msg).not.toMatch(/typo in the url/);
	});

	it("maps ECONNREFUSED (Node) to the same hint", () => {
		expect(
			classifyModelFetchError({
				url,
				error: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			}),
		).toMatch(/Connection refused/);
	});

	it("maps DNS failures to a typo hint", () => {
		expect(
			classifyModelFetchError({
				url,
				error: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
			}),
		).toMatch(/Could not resolve host/);
	});

	it("maps timeouts/aborts to a timeout message", () => {
		expect(
			classifyModelFetchError({
				url,
				error: Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }),
			}),
		).toMatch(/timed out/);
	});

	it("maps an invalid scheme/proxy to an invalid-url message", () => {
		expect(
			classifyModelFetchError({
				url: "htps://api.example.com/v1/models",
				error: Object.assign(new Error("protocol must be http:, https: or s3:"), { code: "ERR_INVALID_ARG_VALUE" }),
			}),
		).toMatch(/Invalid URL or proxy/);
	});

	it("maps TLS/certificate errors", () => {
		expect(classifyModelFetchError({ url, error: new Error("unable to verify the first certificate") })).toMatch(
			/TLS\/certificate error/,
		);
	});

	it("maps a reset socket to a closed-connection message", () => {
		expect(
			classifyModelFetchError({
				url,
				error: Object.assign(new Error("socket connection was closed unexpectedly"), { code: "ECONNRESET" }),
			}),
		).toMatch(/closed unexpectedly/);
	});

	it("falls back to the raw message for unknown errors", () => {
		expect(classifyModelFetchError({ url, error: new Error("weird boom") })).toMatch(/Could not reach .*weird boom/);
	});
});
