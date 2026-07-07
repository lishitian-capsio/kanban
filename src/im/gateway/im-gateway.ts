/**
 * The lightweight resident IM gateway (requirement ac99c, "轻量常驻 gateway").
 *
 * It is the ONLY long-lived piece of the IM integration: it brings up a long connection per
 * platform that has a stored credential AND a registered inbound connector (Lark WebSocket /
 * DingTalk Stream), supervises each connection's lifecycle (start → backoff-reconnect on drop →
 * close), and fans the connectors' normalized inbound events out to its subscribers. The agent is
 * NOT kept resident — only this gateway is; waking an agent on an inbound message is a later task
 * that subscribes via {@link ImGateway.onInboundEvent}.
 *
 * Everything platform-specific is behind the {@link ImGatewayConnector} seam; this class knows
 * nothing about WebSocket / Stream framing. All collaborators (credential check, connector lookup,
 * reconnect scheduler) are injected with production defaults, so the whole supervisor is
 * unit-testable against fake connectors and a manual scheduler with no real network or clock.
 */
import { createLogger } from "../../logging";
import { resolveImCredential } from "../im-credential-store";
import type { ImPlatform } from "../types";
import type { ImConnectionState, ImConnectorContext, ImGatewayConnector } from "./im-gateway-connector";
import { getImGatewayConnector, listRegisteredImGatewayConnectorPlatforms } from "./im-gateway-connector-registry";
import type { ImInboundEvent } from "./inbound-event";

const log = createLogger("im.gateway");

/**
 * Default reconnect backoff schedule (ms), indexed by consecutive failure count and capped at the
 * last entry. Starts fast (a dropped long connection is usually transient) and tops out at 60s so a
 * persistently unreachable platform is retried at a modest, non-spinning cadence.
 */
export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

/** A callback invoked with each normalized inbound event; returns nothing. */
export type ImInboundEventListener = (event: ImInboundEvent) => void;

export interface ImGatewayDeps {
	/**
	 * Whether a platform currently has a usable outbound credential (the gate for starting its
	 * connection). Defaults to the machine-local 0600 IM credential store.
	 */
	hasCredential?: (platform: ImPlatform) => Promise<boolean>;
	/** The platforms that have a registered inbound connector. Defaults to the connector registry. */
	listConnectorPlatforms?: () => ImPlatform[];
	/** Resolve the inbound connector for a platform. Defaults to the connector registry. */
	getConnector?: (platform: ImPlatform) => ImGatewayConnector | null;
	/** Reconnect backoff schedule (ms) indexed by attempt, capped at the last entry. */
	reconnectDelaysMs?: readonly number[];
	/**
	 * Schedule `run` after `delayMs`, returning a cancel function. Injected for deterministic
	 * tests. The default uses an unref'd `setTimeout`, so a pending reconnect never keeps the
	 * process alive on its own.
	 */
	scheduleReconnect?: (delayMs: number, run: () => void) => () => void;
}

/** Per-platform supervision state for one connector. */
interface Supervised {
	readonly platform: ImPlatform;
	readonly connector: ImGatewayConnector;
	state: ImConnectionState;
	/** Consecutive failed attempts since the last successful connect; drives the backoff index. */
	attempt: number;
	/** Cancel handle for a pending reconnect timer, or `null` when none is scheduled. */
	cancelTimer: (() => void) | null;
	/**
	 * Monotonically increasing token bumped on every (re)connect and on stop. A connector's
	 * `emit` / `signalDisconnected` closure captures the token from its cycle; a call whose token
	 * no longer matches is stale (from a prior connection) and ignored.
	 */
	generation: number;
}

function defaultScheduleReconnect(delayMs: number, run: () => void): () => void {
	const timer = setTimeout(run, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

export class ImGateway {
	private readonly hasCredential: NonNullable<ImGatewayDeps["hasCredential"]>;
	private readonly listConnectorPlatforms: NonNullable<ImGatewayDeps["listConnectorPlatforms"]>;
	private readonly getConnector: NonNullable<ImGatewayDeps["getConnector"]>;
	private readonly reconnectDelaysMs: readonly number[];
	private readonly scheduleReconnect: NonNullable<ImGatewayDeps["scheduleReconnect"]>;

	private readonly supervised = new Map<ImPlatform, Supervised>();
	private readonly listeners = new Set<ImInboundEventListener>();
	private started = false;
	private stopped = false;
	/**
	 * Serialization chain for {@link refresh}. Chaining each refresh after the previous one keeps
	 * two concurrent credential changes from racing to bring up the same connection twice.
	 */
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(deps: ImGatewayDeps = {}) {
		this.hasCredential = deps.hasCredential ?? (async (platform) => (await resolveImCredential(platform)) !== null);
		this.listConnectorPlatforms = deps.listConnectorPlatforms ?? listRegisteredImGatewayConnectorPlatforms;
		this.getConnector = deps.getConnector ?? getImGatewayConnector;
		this.reconnectDelaysMs =
			deps.reconnectDelaysMs && deps.reconnectDelaysMs.length > 0
				? deps.reconnectDelaysMs
				: DEFAULT_RECONNECT_DELAYS_MS;
		this.scheduleReconnect = deps.scheduleReconnect ?? defaultScheduleReconnect;
	}

	/**
	 * Subscribe to normalized inbound events from every connection. Returns an unsubscribe. This is
	 * the seam the routing / agent-wake layer consumes; with no subscriber, events are dropped.
	 */
	onInboundEvent(listener: ImInboundEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The current connection state for a platform (`"idle"` when it was never started). */
	getConnectionState(platform: ImPlatform): ImConnectionState {
		return this.supervised.get(platform)?.state ?? "idle";
	}

	/**
	 * Bring up every registered connector whose platform has a stored credential. Idempotent —
	 * a second call while already started is a no-op. Resolves once the initial connect attempt of
	 * each eligible connector has settled (connected, or failed and scheduled for retry).
	 */
	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.started = true;
		this.stopped = false;
		const platforms = this.listConnectorPlatforms();
		await Promise.all(platforms.map((platform) => this.startPlatform(platform)));
	}

	/**
	 * Tear down every connection: cancel pending reconnects, mark each closed, and disconnect each
	 * connector best-effort. After stop, a late `signalDisconnected` from a stale connection is
	 * ignored (its generation no longer matches), so nothing reconnects.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		this.started = false;
		const entries = [...this.supervised.values()];
		await Promise.all(
			entries.map(async (sup) => {
				sup.generation += 1;
				if (sup.cancelTimer) {
					sup.cancelTimer();
					sup.cancelTimer = null;
				}
				sup.state = "closed";
				await this.safeDisconnect(sup);
			}),
		);
	}

	/**
	 * Re-evaluate every platform's credential gate against the currently registered connectors and
	 * bring connections into line: start a platform that gained a credential, stop one that lost it
	 * (or whose connector was unregistered), leaving unchanged platforms untouched. Idempotent and
	 * safe to call at any time after construction — this is the seam credential changes hook into so
	 * a Lark/DingTalk long connection comes up (or drops) without a runtime restart.
	 *
	 * Concurrent calls are serialized via {@link refreshChain}, and a failure only logs (the gateway
	 * is a resident component and must never let a refresh reject into its caller).
	 */
	async refresh(): Promise<void> {
		const run = this.refreshChain.then(() => this.syncConnections());
		// Keep the chain alive on failure so a later refresh still runs, but never surface the error.
		this.refreshChain = run.catch(() => {});
		return run.catch((error) => {
			log.warn("IM gateway refresh failed", { error });
		});
	}

	/** One pass of reconciliation between the desired (credentialed + registered) set and the live one. */
	private async syncConnections(): Promise<void> {
		if (this.stopped) {
			return;
		}
		const registered = new Set(this.listConnectorPlatforms());
		// Stop any live connection whose connector was unregistered or whose credential was cleared.
		for (const sup of [...this.supervised.values()]) {
			const keep = registered.has(sup.platform) && (await this.hasCredential(sup.platform));
			if (!keep) {
				await this.stopPlatform(sup);
			}
		}
		if (this.stopped) {
			return;
		}
		// Bring up any registered, credentialed platform not already supervised. `startPlatform`
		// re-checks the credential and no-ops when the platform is already supervised.
		await Promise.all([...registered].map((platform) => this.startPlatform(platform)));
	}

	private async startPlatform(platform: ImPlatform): Promise<void> {
		if (this.supervised.has(platform)) {
			return;
		}
		const connector = this.getConnector(platform);
		if (!connector) {
			return;
		}
		// Reserve the map slot synchronously — before the `hasCredential` await — so a concurrent
		// start/refresh for the same platform sees the entry and bails, closing the check-then-act
		// race that would otherwise bring up two connections.
		const sup: Supervised = { platform, connector, state: "idle", attempt: 0, cancelTimer: null, generation: 0 };
		this.supervised.set(platform, sup);
		let credentialed: boolean;
		try {
			credentialed = await this.hasCredential(platform);
		} catch (error) {
			this.unreserve(sup);
			log.warn("IM credential check failed; not starting connector", { platform, error });
			return;
		}
		if (!credentialed || this.stopped) {
			this.unreserve(sup);
			if (!credentialed) {
				log.debug("skipping IM connector: no credential configured", { platform });
			}
			return;
		}
		await this.connect(sup);
	}

	/** Drop a reserved-but-not-started slot, but only if it is still the one we reserved. */
	private unreserve(sup: Supervised): void {
		if (this.supervised.get(sup.platform) === sup) {
			this.supervised.delete(sup.platform);
		}
	}

	/**
	 * Gracefully stop a single supervised connection and remove it from the map (so a later
	 * {@link refresh} can bring the platform back up). Mirrors {@link stop} but scoped to one
	 * platform. Bumping the generation invalidates any in-flight emit / drop signal / reconnect.
	 */
	private async stopPlatform(sup: Supervised): Promise<void> {
		sup.generation += 1;
		if (sup.cancelTimer) {
			sup.cancelTimer();
			sup.cancelTimer = null;
		}
		sup.state = "closed";
		this.supervised.delete(sup.platform);
		await this.safeDisconnect(sup);
	}

	/** Run one connect cycle for a supervised connector; on failure, schedule a backoff reconnect. */
	private async connect(sup: Supervised): Promise<void> {
		if (this.stopped) {
			return;
		}
		sup.generation += 1;
		const generation = sup.generation;
		sup.state = sup.attempt === 0 ? "connecting" : "reconnecting";
		const context: ImConnectorContext = {
			emit: (event) => {
				if (generation === sup.generation && !this.stopped) {
					this.fanout(event);
				}
			},
			signalDisconnected: (error) => {
				if (generation === sup.generation) {
					this.handleDrop(sup, error);
				}
			},
		};
		try {
			await sup.connector.connect(context);
		} catch (error) {
			this.handleDrop(sup, error);
			return;
		}
		if (this.stopped || this.supervised.get(sup.platform) !== sup) {
			// Stopped (globally or for this platform, e.g. its credential was cleared mid-connect)
			// while the connect was in flight — do not keep a live connection around.
			await this.safeDisconnect(sup);
			return;
		}
		sup.state = "connected";
		sup.attempt = 0;
	}

	/** Handle a connect failure or an unexpected drop: clean up, then schedule a backoff reconnect. */
	private handleDrop(sup: Supervised, error?: unknown): void {
		if (this.stopped || sup.cancelTimer) {
			// Already stopped, or a reconnect is already scheduled — collapse duplicate signals.
			return;
		}
		// Invalidate the current cycle so any further emit/signal from the dead connection is ignored,
		// then let the connector release its resources before we retry.
		sup.generation += 1;
		void this.safeDisconnect(sup);
		sup.state = "reconnecting";
		const delayMs = this.reconnectDelaysMs[Math.min(sup.attempt, this.reconnectDelaysMs.length - 1)] ?? 0;
		sup.attempt += 1;
		log.warn("IM connection dropped; scheduling reconnect", { platform: sup.platform, delayMs, error });
		sup.cancelTimer = this.scheduleReconnect(delayMs, () => {
			sup.cancelTimer = null;
			void this.connect(sup);
		});
	}

	private fanout(event: ImInboundEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				log.warn("IM inbound event listener threw", { error });
			}
		}
	}

	private async safeDisconnect(sup: Supervised): Promise<void> {
		try {
			await sup.connector.disconnect();
		} catch (error) {
			log.warn("IM connector disconnect failed", { platform: sup.platform, error });
		}
	}
}
