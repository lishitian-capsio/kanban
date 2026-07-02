import { describe, expect, it } from "vitest";

import { engineWireProtocol } from "../../../src/db/types";

describe("engineWireProtocol", () => {
	it("maps the postgres family to the postgres wire protocol", () => {
		expect(engineWireProtocol("postgres")).toBe("postgres");
		expect(engineWireProtocol("cockroachdb")).toBe("postgres");
		expect(engineWireProtocol("timescaledb")).toBe("postgres");
	});

	it("maps the mysql family to the mysql wire protocol", () => {
		expect(engineWireProtocol("mysql")).toBe("mysql");
		expect(engineWireProtocol("mariadb")).toBe("mysql");
	});

	it("maps sqlite and redis to themselves", () => {
		expect(engineWireProtocol("sqlite")).toBe("sqlite");
		expect(engineWireProtocol("redis")).toBe("redis");
	});
});
