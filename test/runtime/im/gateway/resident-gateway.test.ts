import { afterEach, describe, expect, it } from "vitest";
import {
	getResidentImGateway,
	type ResidentImGateway,
	setResidentImGateway,
} from "../../../../src/im/gateway/resident-gateway";

afterEach(() => {
	setResidentImGateway(null);
});

describe("resident IM gateway holder", () => {
	it("returns null before any gateway is registered", () => {
		expect(getResidentImGateway()).toBeNull();
	});

	it("returns the registered gateway so the tRPC router can trigger a refresh", () => {
		let refreshed = 0;
		const gateway: ResidentImGateway = {
			refresh: async () => {
				refreshed += 1;
			},
		};

		setResidentImGateway(gateway);
		void getResidentImGateway()?.refresh();

		expect(getResidentImGateway()).toBe(gateway);
		expect(refreshed).toBe(1);
	});

	it("clears the registration when passed null", () => {
		setResidentImGateway({ refresh: async () => {} });
		setResidentImGateway(null);
		expect(getResidentImGateway()).toBeNull();
	});
});
