import { describe, expect, it } from "vitest";

import {
	buildRemoteStatusData,
	REMOTE_PASSCODE_VIEW_COMMAND,
	type RemoteStatusBuildInput,
} from "../../src/commands/remote-status";

function baseInput(overrides: Partial<RemoteStatusBuildInput> = {}): RemoteStatusBuildInput {
	return {
		bind: { host: "127.0.0.1", port: 3484, https: false },
		isLoopbackBind: true,
		isWildcardBind: false,
		localNetworkHosts: [],
		allowedHostAuthorities: ["127.0.0.1:3484", "localhost:3484"],
		passcode: { value: null, disabled: false },
		health: { reachable: true, checkedUrl: "http://127.0.0.1:3484/api", latencyMs: 5 },
		service: null,
		...overrides,
	};
}

describe("buildRemoteStatusData", () => {
	it("reports a loopback bind as local, passcode not required, single loopback URL", () => {
		const data = buildRemoteStatusData(baseInput());
		expect(data.remoteMode).toBe(false);
		expect(data.accessUrls).toEqual(["http://127.0.0.1:3484"]);
		expect(data.passcode.required).toBe(false);
		expect(data.passcode.viewCommand).toBe(REMOTE_PASSCODE_VIEW_COMMAND);
	});

	it("enumerates NIC IPs (then loopback) for a wildcard bind and marks remote mode", () => {
		const data = buildRemoteStatusData(
			baseInput({
				bind: { host: "0.0.0.0", port: 3484, https: false },
				isLoopbackBind: false,
				isWildcardBind: true,
				localNetworkHosts: ["192.168.1.20", "10.0.0.5"],
			}),
		);
		expect(data.remoteMode).toBe(true);
		expect(data.accessUrls).toEqual(["http://192.168.1.20:3484", "http://10.0.0.5:3484", "http://127.0.0.1:3484"]);
	});

	it("lists the concrete host then loopback for a fixed remote bind, honoring https", () => {
		const data = buildRemoteStatusData(
			baseInput({
				bind: { host: "192.168.1.20", port: 8443, https: true },
				isLoopbackBind: false,
				isWildcardBind: false,
			}),
		);
		expect(data.accessUrls).toEqual(["https://192.168.1.20:8443", "https://127.0.0.1:8443"]);
	});

	it("brackets routable IPv6 NIC addresses in access URLs", () => {
		const data = buildRemoteStatusData(
			baseInput({
				bind: { host: "::", port: 3484, https: false },
				isLoopbackBind: false,
				isWildcardBind: true,
				localNetworkHosts: ["2001:db8::1"],
			}),
		);
		expect(data.accessUrls).toContain("http://[2001:db8::1]:3484");
	});

	it("excludes link-local NIC addresses from access URLs on a wildcard bind", () => {
		const data = buildRemoteStatusData(
			baseInput({
				bind: { host: "0.0.0.0", port: 3484, https: false },
				isLoopbackBind: false,
				isWildcardBind: true,
				localNetworkHosts: ["192.168.1.20", "fe80::1", "169.254.1.1"],
				allowedHostAuthorities: ["192.168.1.20:3484", "[fe80::1]:3484", "127.0.0.1:3484"],
			}),
		);
		// Access URLs drop un-shareable link-local addresses…
		expect(data.accessUrls).toEqual(["http://192.168.1.20:3484", "http://127.0.0.1:3484"]);
		// …but allowedHosts mirrors the Host gate verbatim (link-local included).
		expect(data.allowedHosts).toContain("[fe80::1]:3484");
	});

	it("marks passcode required+set when a remote bind has a persisted value", () => {
		const data = buildRemoteStatusData(
			baseInput({
				bind: { host: "192.168.1.20", port: 3484, https: false },
				isLoopbackBind: false,
				passcode: { value: "ABCdef23", disabled: false },
			}),
		);
		expect(data.passcode).toMatchObject({ required: true, set: true, source: "persisted" });
	});

	it("never includes the passcode value in the output", () => {
		const data = buildRemoteStatusData(
			baseInput({
				isLoopbackBind: false,
				bind: { host: "192.168.1.20", port: 3484, https: false },
				passcode: { value: "SECRET12", disabled: false },
			}),
		);
		expect(JSON.stringify(data)).not.toContain("SECRET12");
	});

	it("treats a persisted disable as not-required and unset even on a remote bind", () => {
		const data = buildRemoteStatusData(
			baseInput({
				isLoopbackBind: false,
				bind: { host: "192.168.1.20", port: 3484, https: false },
				passcode: { value: null, disabled: true },
			}),
		);
		expect(data.passcode).toMatchObject({ required: false, set: false, source: "none" });
	});

	it("reports required-but-unset for a remote bind with no passcode", () => {
		const data = buildRemoteStatusData(
			baseInput({
				isLoopbackBind: false,
				bind: { host: "192.168.1.20", port: 3484, https: false },
				passcode: { value: null, disabled: false },
			}),
		);
		expect(data.passcode).toMatchObject({ required: true, set: false, source: "none" });
	});

	it("surfaces the Host gate authorities, sorted, as allowedHosts", () => {
		const data = buildRemoteStatusData(
			baseInput({ allowedHostAuthorities: ["localhost:3484", "192.168.1.20:3484", "127.0.0.1:3484"] }),
		);
		expect(data.allowedHosts).toEqual(["127.0.0.1:3484", "192.168.1.20:3484", "localhost:3484"]);
	});

	it("passes the service summary through unchanged", () => {
		const service = { installed: true, running: true, platform: "systemd", name: "kanban" };
		const data = buildRemoteStatusData(baseInput({ service }));
		expect(data.service).toEqual(service);
	});

	it("carries the health probe through verbatim", () => {
		const health = { reachable: false, checkedUrl: "http://127.0.0.1:3484/api", latencyMs: null };
		const data = buildRemoteStatusData(baseInput({ health }));
		expect(data.health).toEqual(health);
	});
});
