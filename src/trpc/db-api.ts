import { TRPCError } from "@trpc/server";

import type {
	RuntimeDbBrowseResponse,
	RuntimeDbConnection,
	RuntimeDbConnectionAddRequest,
	RuntimeDbConnectionAddResponse,
	RuntimeDbConnectionListResponse,
	RuntimeDbConnectionRemoveResponse,
	RuntimeDbConnectionTestResponse,
	RuntimeDbDescribeResponse,
	RuntimeDbQueryResponse,
	RuntimeDbTablesResponse,
} from "../core/api-contract";
import { DatabaseService } from "../db/db-service";
import { DbError } from "../db/errors";
import { QueryExecutionError, QueryExecutor } from "../db/execution";
import { PoolManager } from "../db/pool/pool-manager";
import type { ConnectionRecord, DbCredential } from "../db/registry/connection-store";
import { normalizeConnId } from "../db/registry/connection-store";
import { createLogger } from "../logging";
import {
	loadDbCredential,
	loadWorkspaceDbConnections,
	mutateDbCredential,
	mutateWorkspaceDbConnections,
} from "../state/workspace-state";
import type { RuntimeTrpcContext } from "./app-router";

const log = createLogger("trpc:db-api");

/**
 * Persistence + execution seams the DB CLI surface depends on. Defaulted to the real
 * workspace-state stores and a process-wide {@link PoolManager}; injected with fakes in
 * tests so the API can be exercised without touching `~/.kanban` or a live database.
 */
export interface CreateDbApiDependencies {
	/** Process-wide pool of live drivers (one per connection id). */
	poolManager?: PoolManager;
	/** Load a workspace's committed, secret-free connection records. */
	loadConnections?: (workspaceId: string) => Promise<ConnectionRecord[]>;
	/** Locked read→mutate→write of a workspace's committed connection records. */
	mutateConnections?: (
		workspaceId: string,
		mutate: (records: ConnectionRecord[]) => ConnectionRecord[] | Promise<ConnectionRecord[]>,
	) => Promise<ConnectionRecord[]>;
	/** Load one machine-home credential by (normalized) connection id. */
	loadCredential?: (connId: string) => Promise<DbCredential | undefined>;
	/** Read→mutate→write one machine-home credential. */
	mutateCredential?: (
		connId: string,
		mutate: (current: DbCredential | undefined) => DbCredential | undefined,
	) => Promise<void>;
	/** ISO timestamp source for `createdAt` (no Date.now in stored/pure code; the boundary supplies it). */
	now?: () => Date;
}

function toConnectionWire(record: ConnectionRecord, hasCredential: boolean): RuntimeDbConnection {
	return {
		connId: record.connId,
		label: record.label,
		engine: record.engine,
		host: record.host,
		port: record.port,
		database: record.database,
		user: record.user,
		filePath: record.filePath,
		ssl: record.ssl,
		allowWrites: record.allowWrites,
		createdAt: record.createdAt,
		hasCredential,
	};
}

/**
 * Resolve a (case-insensitive) table name to its exact `{schema, name}` using the lazy,
 * cached name listings — so `db.describe` reads one table's detail instead of introspecting
 * the whole catalog. An optional schema qualifier is matched case-insensitively too.
 */
async function locateTable(
	service: DatabaseService,
	connId: string,
	table: string,
	schema?: string,
): Promise<{ schema: string; name: string } | null> {
	const schemas = await service.listSchemas({ connId, caller: "cli" });
	const schemaFilter = schema?.trim().toLowerCase();
	const candidates = schemaFilter ? schemas.filter((s) => s.name.toLowerCase() === schemaFilter) : schemas;
	const target = table.toLowerCase();
	for (const s of candidates) {
		const tables = await service.listTables({ connId, caller: "cli", schema: s.name });
		const match = tables.find((t) => t.name.toLowerCase() === target);
		if (match) {
			return { schema: match.schema, name: match.name };
		}
	}
	return null;
}

/** Derive a stable, filename-safe connection id from a human label. */
function slugifyConnId(label: string): string {
	const slug = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "connection";
}

/** Map any DB-core error to a caller-safe tRPC error (secrets already scrubbed by the core). */
function toTrpcError(error: unknown): TRPCError {
	if (error instanceof QueryExecutionError) {
		return new TRPCError({ code: "BAD_REQUEST", message: error.normalized.message, cause: error });
	}
	if (error instanceof DbError) {
		return new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
	}
	if (error instanceof TRPCError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message, cause: error });
}

/**
 * The `kanban db` surface, layered on the shared DB core. It owns no connection/query/
 * introspection logic of its own — every operation routes through {@link DatabaseService}
 * (the secret-resolution + policy chokepoint) and {@link QueryExecutor} (bounded, paginated
 * reads with the core's default read-only + row/byte caps). The CLI caller is `"cli"`, which
 * the access policy caps to strictly read-only — writes/DDL are refused even on an
 * `allowWrites` connection (those are reserved for the human Database UI's primary-key-gated
 * row edits). So this surface is connection management + read-only data access only.
 */
export function createDbApi(deps: CreateDbApiDependencies = {}): RuntimeTrpcContext["dbApi"] {
	const poolManager = deps.poolManager ?? new PoolManager();
	const loadConnections = deps.loadConnections ?? loadWorkspaceDbConnections;
	const mutateConnections = deps.mutateConnections ?? mutateWorkspaceDbConnections;
	const loadCredential = deps.loadCredential ?? loadDbCredential;
	const mutateCredential = deps.mutateCredential ?? mutateDbCredential;
	const now = deps.now ?? (() => new Date());

	const findConnection = async (workspaceId: string, connId: string): Promise<ConnectionRecord | null> => {
		const id = normalizeConnId(connId);
		const records = await loadConnections(workspaceId);
		return records.find((record) => record.connId === id) ?? null;
	};

	const buildService = (workspaceId: string): DatabaseService =>
		new DatabaseService({
			poolManager,
			loadConnection: (connId) => findConnection(workspaceId, connId),
			loadCredential,
		});

	const buildExecutor = (workspaceId: string): QueryExecutor =>
		new QueryExecutor({
			service: buildService(workspaceId),
			loadConnection: (connId) => findConnection(workspaceId, connId),
		});

	const requireConnection = async (workspaceId: string, connId: string): Promise<ConnectionRecord> => {
		const record = await findConnection(workspaceId, connId);
		if (!record) {
			throw new TRPCError({ code: "NOT_FOUND", message: `unknown connection: "${connId}"` });
		}
		return record;
	};

	return {
		listConnections: async (scope): Promise<RuntimeDbConnectionListResponse> => {
			const records = await loadConnections(scope.workspaceId);
			const connections = await Promise.all(
				records.map(async (record) =>
					toConnectionWire(record, (await loadCredential(record.connId)) !== undefined),
				),
			);
			return { connections };
		},

		addConnection: async (scope, input): Promise<RuntimeDbConnectionAddResponse> => {
			const connId = normalizeConnId((input.connId ?? "").trim() || slugifyConnId(input.label));
			const record: ConnectionRecord = {
				connId,
				label: input.label.trim(),
				engine: input.engine,
				host: input.host ?? null,
				port: input.port ?? null,
				database: input.database ?? null,
				user: input.user ?? null,
				filePath: input.filePath ?? null,
				ssl: input.ssl ?? null,
				allowWrites: input.engine === "redis" ? false : (input.allowWrites ?? false),
				createdAt: now().toISOString(),
			};

			await mutateConnections(scope.workspaceId, (records) => {
				if (records.some((existing) => existing.connId === connId)) {
					throw new TRPCError({ code: "CONFLICT", message: `connection "${connId}" already exists` });
				}
				return [...records, record];
			});

			// Secrets live ONLY in machine-home credentials, keyed by connId — never committed.
			const credential = buildCredential(input);
			const hasCredential = credential !== undefined;
			if (hasCredential) {
				await mutateCredential(connId, () => credential);
			}

			return { connection: toConnectionWire(record, hasCredential) };
		},

		removeConnection: async (scope, input): Promise<RuntimeDbConnectionRemoveResponse> => {
			const connId = normalizeConnId(input.connId);
			let removed = false;
			await mutateConnections(scope.workspaceId, (records) => {
				const next = records.filter((record) => record.connId !== connId);
				removed = next.length !== records.length;
				return next;
			});
			if (removed) {
				// Drop the secret and tear down any live driver so a removed connection leaves nothing behind.
				await mutateCredential(connId, () => undefined);
				await poolManager.invalidate(connId);
			}
			return { connId, removed };
		},

		testConnection: async (scope, input): Promise<RuntimeDbConnectionTestResponse> => {
			const record = await requireConnection(scope.workspaceId, input.connId);
			try {
				const result = await buildService(scope.workspaceId).testConnection(record.connId);
				return {
					connId: record.connId,
					reachable: result.ok,
					latencyMs: result.latencyMs,
					serverVersion: result.serverVersion,
				};
			} catch (error) {
				// A failed connection test is reported as data, not an exception, so the CLI can show why.
				log.debug("connection test failed", { connId: record.connId, error });
				return {
					connId: record.connId,
					reachable: false,
					latencyMs: null,
					serverVersion: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		listTables: async (scope, input): Promise<RuntimeDbTablesResponse> => {
			const record = await requireConnection(scope.workspaceId, input.connId);
			try {
				const service = buildService(scope.workspaceId);
				// Lazy + cached: read the schema list, then table NAMES per schema — never every
				// column of every table (the eager `introspect()` cost the entry used to pay on
				// each call). Repeat expansions of an unchanged catalog hit the IntrospectionCache.
				const schemas = await service.listSchemas({ connId: record.connId, caller: "cli" });
				const filter = input.schema?.trim().toLowerCase();
				const wanted = filter ? schemas.filter((s) => s.name.toLowerCase() === filter) : schemas;
				const perSchema = await Promise.all(
					wanted.map((s) => service.listTables({ connId: record.connId, caller: "cli", schema: s.name })),
				);
				const tables = perSchema.flat().map((table) => ({
					schema: table.schema,
					name: table.name,
					kind: table.kind,
				}));
				return { connId: record.connId, engine: record.engine, tables };
			} catch (error) {
				throw toTrpcError(error);
			}
		},

		describeTable: async (scope, input): Promise<RuntimeDbDescribeResponse> => {
			const record = await requireConnection(scope.workspaceId, input.connId);
			try {
				const service = buildService(scope.workspaceId);
				// Resolve the table to its exact (schema, name) via cached name listings, then read
				// ONE table's detail — instead of introspecting the whole catalog and filtering.
				const located = await locateTable(service, record.connId, input.table, input.schema);
				if (!located) {
					return { connId: record.connId, engine: record.engine, table: null };
				}
				const detail = await service.describeTable({
					connId: record.connId,
					caller: "cli",
					schema: located.schema,
					table: located.name,
				});
				return {
					connId: record.connId,
					engine: record.engine,
					table: { schema: detail.schema, name: detail.name, kind: detail.kind, columns: detail.columns },
				};
			} catch (error) {
				throw toTrpcError(error);
			}
		},

		browseTable: async (scope, input): Promise<RuntimeDbBrowseResponse> => {
			const record = await requireConnection(scope.workspaceId, input.connId);
			try {
				const result = await buildExecutor(scope.workspaceId).browseTable({
					connId: record.connId,
					schema: input.schema,
					table: input.table,
					caller: "cli",
					page:
						input.pageSize !== undefined || input.cursor !== undefined
							? { pageSize: input.pageSize, cursor: input.cursor }
							: undefined,
				});
				return {
					connId: record.connId,
					columns: result.columns,
					rows: result.rows,
					rowCount: result.rowCount,
					affectedRows: result.affectedRows,
					classification: result.classification,
					readOnly: result.readOnly,
					durationMs: result.durationMs,
					totalDurationMs: result.totalDurationMs,
					pagination: result.pagination,
					truncated: result.truncated,
				};
			} catch (error) {
				throw toTrpcError(error);
			}
		},

		runQuery: async (scope, input): Promise<RuntimeDbQueryResponse> => {
			const record = await requireConnection(scope.workspaceId, input.connId);
			try {
				const result = await buildExecutor(scope.workspaceId).execute({
					connId: record.connId,
					sql: input.sql,
					caller: "cli",
					page:
						input.pageSize !== undefined || input.cursor !== undefined
							? { pageSize: input.pageSize, cursor: input.cursor }
							: undefined,
				});
				return {
					connId: record.connId,
					columns: result.columns,
					rows: result.rows,
					rowCount: result.rowCount,
					affectedRows: result.affectedRows,
					classification: result.classification,
					readOnly: result.readOnly,
					durationMs: result.durationMs,
					totalDurationMs: result.totalDurationMs,
					pagination: result.pagination,
					truncated: result.truncated,
				};
			} catch (error) {
				throw toTrpcError(error);
			}
		},
	};
}

/** Assemble the secret credential from an add request, or `undefined` when no secret was given. */
function buildCredential(input: RuntimeDbConnectionAddRequest): DbCredential | undefined {
	const credential: DbCredential = {
		...(input.password !== undefined ? { password: input.password } : {}),
		...(input.sslKeyPem !== undefined ? { sslKeyPem: input.sslKeyPem } : {}),
		...(input.sslCertPem !== undefined ? { sslCertPem: input.sslCertPem } : {}),
	};
	return Object.keys(credential).length > 0 ? credential : undefined;
}
