import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";

import type {
	RuntimeDbBrowseTableRequest,
	RuntimeDbBrowseTableResponse,
	RuntimeDbConnection,
	RuntimeDbConnectionsListResponse,
	RuntimeDbDeleteConnectionRequest,
	RuntimeDbDeleteConnectionResponse,
	RuntimeDbDeleteRowRequest,
	RuntimeDbInsertRowRequest,
	RuntimeDbIntrospectRequest,
	RuntimeDbIntrospectResponse,
	RuntimeDbTestConnectionRequest,
	RuntimeDbTestConnectionResponse,
	RuntimeDbUpdateRowRequest,
	RuntimeDbUpsertConnectionRequest,
	RuntimeDbUpsertConnectionResponse,
	RuntimeDbWriteResponse,
} from "../core/api-contract";
import {
	buildBrowseQuery,
	buildDeleteRow,
	buildInsertRow,
	buildUpdateRow,
	type ConnectionConfig,
	type ConnectionRecord,
	createDriver,
	DbError,
	DbPolicyError,
	formatDbRow,
	normalizeConnId,
	QueryExecutionError,
} from "../db";
import { createLogger } from "../logging";
import {
	loadDbCredential,
	loadWorkspaceDbConnections,
	mutateDbCredential,
	mutateWorkspaceDbConnections,
} from "../state/workspace-state";
import { getWorkspaceDbStack } from "../workspace/workspace-db-service";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";

const log = createLogger("trpc:workspace-db");

/** The human Database UI always runs as the `human` caller; writes are gated by `allowWrites`. */
const CALLER = "human" as const;

function toRuntimeConnection(record: ConnectionRecord, hasCredential: boolean): RuntimeDbConnection {
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

/** Translate a DB-core error into a safe TRPCError. Messages from the core are already scrubbed. */
function toTrpcError(error: unknown): TRPCError {
	if (error instanceof QueryExecutionError) {
		const { code, message } = error.normalized;
		const trpcCode =
			code === "policy_denied"
				? "FORBIDDEN"
				: code === "timeout" || code === "cancelled"
					? "TIMEOUT"
					: code === "unknown"
						? "INTERNAL_SERVER_ERROR"
						: "BAD_REQUEST";
		return new TRPCError({ code: trpcCode, message });
	}
	if (error instanceof DbPolicyError) {
		return new TRPCError({ code: "FORBIDDEN", message: error.message });
	}
	if (error instanceof DbError) {
		return new TRPCError({ code: "BAD_REQUEST", message: error.message });
	}
	log.error("unexpected database error", { error });
	return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unexpected database error." });
}

async function loadRecordOrThrow(workspaceId: string, connId: string): Promise<ConnectionRecord> {
	const target = normalizeConnId(connId);
	const records = await loadWorkspaceDbConnections(workspaceId);
	const record = records.find((r) => normalizeConnId(r.connId) === target);
	if (!record) {
		throw new TRPCError({ code: "NOT_FOUND", message: `Unknown connection: ${connId}` });
	}
	return record;
}

export interface WorkspaceDbApi {
	listConnections: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeDbConnectionsListResponse>;
	upsertConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeDbUpsertConnectionRequest,
	) => Promise<RuntimeDbUpsertConnectionResponse>;
	deleteConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeDbDeleteConnectionRequest,
	) => Promise<RuntimeDbDeleteConnectionResponse>;
	testConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeDbTestConnectionRequest,
	) => Promise<RuntimeDbTestConnectionResponse>;
	introspect: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeDbIntrospectRequest,
	) => Promise<RuntimeDbIntrospectResponse>;
	browseTable: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeDbBrowseTableRequest,
	) => Promise<RuntimeDbBrowseTableResponse>;
	updateRow: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeDbUpdateRowRequest) => Promise<RuntimeDbWriteResponse>;
	insertRow: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeDbInsertRowRequest) => Promise<RuntimeDbWriteResponse>;
	deleteRow: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeDbDeleteRowRequest) => Promise<RuntimeDbWriteResponse>;
}

export function createWorkspaceDbApi(): WorkspaceDbApi {
	return {
		async listConnections(scope) {
			const records = await loadWorkspaceDbConnections(scope.workspaceId);
			const connections = await Promise.all(
				records.map(async (record) => {
					const credential = await loadDbCredential(record.connId);
					return toRuntimeConnection(record, Boolean(credential?.password));
				}),
			);
			return { connections };
		},

		async upsertConnection(scope, input) {
			const isEdit = Boolean(input.connId);
			const connId = normalizeConnId(input.connId ?? randomUUID());
			const records = await mutateWorkspaceDbConnections(scope.workspaceId, (current) => {
				const existing = current.find((r) => normalizeConnId(r.connId) === connId);
				const next: ConnectionRecord = {
					connId,
					label: input.label,
					engine: input.engine,
					host: input.host ?? null,
					port: input.port ?? null,
					database: input.database ?? null,
					user: input.user ?? null,
					filePath: input.filePath ?? null,
					ssl: input.ssl ?? null,
					allowWrites: input.engine === "redis" ? false : input.allowWrites,
					createdAt: existing?.createdAt ?? new Date().toISOString(),
				};
				const others = current.filter((r) => normalizeConnId(r.connId) !== connId);
				return [...others, next];
			});

			// Apply the secret only when the caller sent one (string sets, null clears, undefined keeps).
			if (input.password !== undefined) {
				await mutateDbCredential(connId, (cur) => {
					if (input.password === null || input.password === "") {
						if (!cur) {
							return undefined;
						}
						const rest = { ...cur };
						delete rest.password;
						return Object.keys(rest).length > 0 ? rest : undefined;
					}
					return { ...cur, password: input.password };
				});
			}

			// Drop any pooled driver so the next query uses the new config/secret.
			await getWorkspaceDbStack(scope.workspaceId).service.invalidate(connId);

			const saved = records.find((r) => normalizeConnId(r.connId) === connId);
			if (!saved) {
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to persist connection." });
			}
			const credential = await loadDbCredential(connId);
			log.info(isEdit ? "updated db connection" : "created db connection", { connId, engine: input.engine });
			return { connection: toRuntimeConnection(saved, Boolean(credential?.password)) };
		},

		async deleteConnection(scope, input) {
			const connId = normalizeConnId(input.connId);
			let deleted = false;
			await mutateWorkspaceDbConnections(scope.workspaceId, (current) => {
				const next = current.filter((r) => normalizeConnId(r.connId) !== connId);
				deleted = next.length !== current.length;
				return next;
			});
			if (deleted) {
				await mutateDbCredential(connId, () => undefined);
				await getWorkspaceDbStack(scope.workspaceId).service.invalidate(connId);
				log.info("deleted db connection", { connId });
			}
			return { deleted };
		},

		async testConnection(_scope, input) {
			const storedPassword = input.connId ? (await loadDbCredential(input.connId))?.password : undefined;
			const password = input.password != null ? input.password : storedPassword;
			const config: ConnectionConfig = {
				engine: input.engine,
				host: input.host ?? undefined,
				port: input.port ?? undefined,
				database: input.database ?? undefined,
				user: input.user ?? undefined,
				filePath: input.filePath ?? undefined,
				ssl: input.ssl ?? undefined,
				password,
			};
			const driver = createDriver(config);
			try {
				await driver.connect();
				const result = await driver.testConnection();
				return { ok: result.ok, latencyMs: result.latencyMs, serverVersion: result.serverVersion, error: null };
			} catch (error) {
				const message = error instanceof DbError || error instanceof Error ? error.message : "Connection failed.";
				log.debug("db test connection failed", { engine: input.engine, error });
				return { ok: false, latencyMs: null, serverVersion: null, error: message };
			} finally {
				await driver.disconnect().catch(() => {});
			}
		},

		async introspect(scope, input) {
			try {
				const schema = await getWorkspaceDbStack(scope.workspaceId).service.introspect({
					connId: input.connId,
					caller: CALLER,
				});
				return {
					engine: schema.engine,
					tables: schema.tables.map((table) => ({
						schema: table.schema,
						name: table.name,
						kind: table.kind,
						columns: table.columns.map((col) => ({
							name: col.name,
							dataType: col.dataType,
							nullable: col.nullable,
							isPrimaryKey: col.isPrimaryKey,
							defaultValue: col.defaultValue,
						})),
					})),
				};
			} catch (error) {
				throw toTrpcError(error);
			}
		},

		async browseTable(scope, input) {
			const record = await loadRecordOrThrow(scope.workspaceId, input.connId);
			try {
				// Redis has no SQL browse — route through the executor's keyspace dispatch instead of
				// buildBrowseQuery, which is SQL-only and would fail for redis connections.
				if (record.engine === "redis") {
					const result = await getWorkspaceDbStack(scope.workspaceId).executor.browseTable({
						connId: input.connId,
						schema: input.schema,
						table: input.table,
						caller: CALLER,
						page: { pageSize: input.pageSize, cursor: input.cursor },
					});
					return {
						columns: result.columns.map((c) => ({ name: c.name, dataType: c.dataType ?? null })),
						rows: result.rows.map((row) => formatDbRow(row)),
						rowCount: result.rowCount,
						pagination: {
							pageSize: result.pagination.pageSize,
							hasMore: result.pagination.hasMore,
							nextCursor: result.pagination.nextCursor,
						},
						truncated: result.truncated,
					};
				}
				const built = buildBrowseQuery({
					engine: record.engine,
					schema: input.schema,
					table: input.table,
					filters: input.filters,
					sort: input.sort,
				});
				const result = await getWorkspaceDbStack(scope.workspaceId).executor.execute({
					connId: input.connId,
					sql: built.sql,
					params: built.params,
					caller: CALLER,
					page: { pageSize: input.pageSize, cursor: input.cursor },
				});
				return {
					columns: result.columns.map((c) => ({ name: c.name, dataType: c.dataType ?? null })),
					rows: result.rows.map((row) => formatDbRow(row)),
					rowCount: result.rowCount,
					pagination: {
						pageSize: result.pagination.pageSize,
						hasMore: result.pagination.hasMore,
						nextCursor: result.pagination.nextCursor,
					},
					truncated: result.truncated,
				};
			} catch (error) {
				throw toTrpcError(error);
			}
		},

		async updateRow(scope, input) {
			const record = await loadRecordOrThrow(scope.workspaceId, input.connId);
			const built = buildUpdateRow({
				engine: record.engine,
				schema: input.schema,
				table: input.table,
				assignments: input.assignments,
				where: input.where,
			});
			return runWrite(scope.workspaceId, input.connId, built);
		},

		async insertRow(scope, input) {
			const record = await loadRecordOrThrow(scope.workspaceId, input.connId);
			const built = buildInsertRow({
				engine: record.engine,
				schema: input.schema,
				table: input.table,
				values: input.values,
			});
			return runWrite(scope.workspaceId, input.connId, built);
		},

		async deleteRow(scope, input) {
			const record = await loadRecordOrThrow(scope.workspaceId, input.connId);
			const built = buildDeleteRow({
				engine: record.engine,
				schema: input.schema,
				table: input.table,
				where: input.where,
			});
			return runWrite(scope.workspaceId, input.connId, built);
		},
	};
}

async function runWrite(
	workspaceId: string,
	connId: string,
	built: { sql: string; params: Array<string | null> },
): Promise<RuntimeDbWriteResponse> {
	try {
		const result = await getWorkspaceDbStack(workspaceId).executor.execute({
			connId,
			sql: built.sql,
			params: built.params,
			caller: CALLER,
		});
		return { affectedRows: result.affectedRows };
	} catch (error) {
		throw toTrpcError(error);
	}
}
