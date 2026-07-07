import { afterEach, describe, expect, it } from "vitest";
import type { ImConnectorContext, ImGatewayConnector } from "../../../../src/im/gateway/im-gateway-connector";
import {
	getImGatewayConnector,
	listRegisteredImGatewayConnectorPlatforms,
	registerImGatewayConnector,
	unregisterImGatewayConnector,
} from "../../../../src/im/gateway/im-gateway-connector-registry";
import type { ImPlatform } from "../../../../src/im/types";

/** A minimal no-op connector used to prove the registry shape + behavior. */
function makeFakeConnector(platform: ImPlatform): ImGatewayConnector {
	return {
		platform,
		async connect(_context: ImConnectorContext): Promise<void> {},
		async disconnect(): Promise<void> {},
	};
}

describe("im-gateway-connector-registry", () => {
	afterEach(() => {
		unregisterImGatewayConnector("lark");
		unregisterImGatewayConnector("dingtalk");
	});

	it("registers a connector keyed by its own platform id and returns it", () => {
		const lark = makeFakeConnector("lark");
		registerImGatewayConnector(lark);
		expect(getImGatewayConnector("lark")).toBe(lark);
	});

	it("getImGatewayConnector returns null when none is registered for the platform", () => {
		expect(getImGatewayConnector("dingtalk")).toBeNull();
	});

	it("re-registering the same platform replaces the previous connector (last wins)", () => {
		const first = makeFakeConnector("lark");
		const second = makeFakeConnector("lark");
		registerImGatewayConnector(first);
		registerImGatewayConnector(second);
		expect(getImGatewayConnector("lark")).toBe(second);
	});

	it("unregisterImGatewayConnector removes the connector", () => {
		registerImGatewayConnector(makeFakeConnector("lark"));
		unregisterImGatewayConnector("lark");
		expect(getImGatewayConnector("lark")).toBeNull();
	});

	it("listRegisteredImGatewayConnectorPlatforms reflects the registered platforms", () => {
		expect(listRegisteredImGatewayConnectorPlatforms()).toEqual([]);
		registerImGatewayConnector(makeFakeConnector("lark"));
		registerImGatewayConnector(makeFakeConnector("dingtalk"));
		expect(listRegisteredImGatewayConnectorPlatforms().sort()).toEqual(["dingtalk", "lark"]);
	});
});
