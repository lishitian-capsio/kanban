/**
 * Process-wide holder for the single resident {@link ImGateway} created in `cli.ts`.
 *
 * The gateway is a long-lived singleton but is instantiated at startup (not lazily), so — mirroring
 * the in-process proxy holder (`config/proxy-fetch.ts`) and `getImCredentialService()` — this tiny
 * holder lets the tRPC `im` router reach it to trigger a {@link ImGateway.refresh} when a credential
 * changes (setCredentials / clearCredentials), without threading the instance through every request
 * context.
 *
 * It is typed structurally (only `refresh`) so this module stays a leaf with NO backend imports —
 * important because it is reachable from the tRPC router type, which is typechecked under the
 * web-ui DOM lib too (the dual-lib rule).
 */
export interface ResidentImGateway {
	/** Idempotently re-evaluate each platform's credential gate and start/stop connections. */
	refresh(): Promise<void>;
}

let resident: ResidentImGateway | null = null;

/** Register (or, with `null`, clear) the process-wide resident gateway. Called once from `cli.ts`. */
export function setResidentImGateway(gateway: ResidentImGateway | null): void {
	resident = gateway;
}

/** The resident gateway, or `null` when the runtime has none (e.g. under tests / before startup). */
export function getResidentImGateway(): ResidentImGateway | null {
	return resident;
}
