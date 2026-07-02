import { TRPCError } from "@trpc/server";

import { createLogger } from "../logging";
import { normalizeConnId } from "../storage";
import type { StorageConnectionRecord } from "../storage";
import {
	loadStorageCredential,
	loadWorkspaceStorageConnections,
	mutateStorageCredential,
	mutateWorkspaceStorageConnections,
} from "../state/workspace-state";
import { safeRandomUUID } from "../core/safe-uuid";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";
import type {
	RuntimeStorageConnection,
	RuntimeStorageConnectionsListResponse,
	RuntimeStorageDeleteConnectionRequest,
	RuntimeStorageDeleteConnectionResponse,
	RuntimeStorageDownloadRequest,
	RuntimeStorageDownloadResponse,
	RuntimeStorageListRequest,
	RuntimeStorageListResponse,
	RuntimeStorageObjectContent,
	RuntimeStorageReadRequest,
	RuntimeStorageStatRequest,
	RuntimeStorageStatResponse,
	RuntimeStorageTestConnectionRequest,
	RuntimeStorageTestConnectionResponse,
	RuntimeStorageUpsertConnectionRequest,
	RuntimeStorageUpsertConnectionResponse,
} from "../core/api-contract";
import { getWorkspaceStorageService } from "../workspace/workspace-storage-service";

const log = createLogger("storage:api");

export function toRuntimeStorageConnection(
	record: StorageConnectionRecord,
	hasCredential: boolean,
): RuntimeStorageConnection {
	return {
		connId: record.connId,
		label: record.label,
		endpoint: record.endpoint,
		region: record.region,
		bucket: record.bucket,
		virtualHostedStyle: record.virtualHostedStyle,
		hasCredential,
		createdAt: record.createdAt,
	};
}

async function hasStoredCredential(connId: string): Promise<boolean> {
	const cred = await loadStorageCredential(connId);
	return Boolean(cred?.accessKeyId && cred?.secretAccessKey);
}

export interface WorkspaceStorageApi {
	listConnections: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeStorageConnectionsListResponse>;
	upsertConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageUpsertConnectionRequest,
	) => Promise<RuntimeStorageUpsertConnectionResponse>;
	deleteConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageDeleteConnectionRequest,
	) => Promise<RuntimeStorageDeleteConnectionResponse>;
	testConnection: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageTestConnectionRequest,
	) => Promise<RuntimeStorageTestConnectionResponse>;
	listObjects: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageListRequest) => Promise<RuntimeStorageListResponse>;
	readObject: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageReadRequest) => Promise<RuntimeStorageObjectContent>;
	statObject: (scope: RuntimeTrpcWorkspaceScope, input: RuntimeStorageStatRequest) => Promise<RuntimeStorageStatResponse>;
	downloadObject: (
		scope: RuntimeTrpcWorkspaceScope,
		input: RuntimeStorageDownloadRequest,
	) => Promise<RuntimeStorageDownloadResponse>;
}

export function createWorkspaceStorageApi(): WorkspaceStorageApi {
	return {
		async listConnections(scope) {
			const records = await loadWorkspaceStorageConnections(scope.workspaceId);
			const connections = await Promise.all(
				records.map(async (record) => toRuntimeStorageConnection(record, await hasStoredCredential(record.connId))),
			);
			return { connections };
		},

		async upsertConnection(scope, input) {
			const connId = normalizeConnId(input.connId ?? safeRandomUUID());
			const records = await mutateWorkspaceStorageConnections(scope.workspaceId, (current) => {
				const existing = current.find((r) => normalizeConnId(r.connId) === connId);
				const next: StorageConnectionRecord = {
					connId,
					label: input.label,
					endpoint: input.endpoint,
					region: input.region,
					bucket: input.bucket,
					virtualHostedStyle: input.virtualHostedStyle,
					createdAt: existing?.createdAt ?? new Date().toISOString(),
				};
				return [...current.filter((r) => normalizeConnId(r.connId) !== connId), next];
			});

			// Apply the secret only when a full pair is provided; null/"" clears; undefined keeps.
			const setKey = input.accessKeyId;
			const setSecret = input.secretAccessKey;
			if (setKey !== undefined || setSecret !== undefined || input.sessionToken !== undefined) {
				await mutateStorageCredential(connId, (cur) => {
					const clearing =
						(setKey === null || setKey === "") && (setSecret === null || setSecret === "");
					if (clearing) {
						return undefined;
					}
					return {
						accessKeyId: setKey ?? cur?.accessKeyId,
						secretAccessKey: setSecret ?? cur?.secretAccessKey,
						sessionToken:
							input.sessionToken === null || input.sessionToken === ""
								? undefined
								: (input.sessionToken ?? cur?.sessionToken),
					};
				});
			}

			const saved = records.find((r) => normalizeConnId(r.connId) === connId);
			if (!saved) {
				throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to persist storage connection." });
			}
			log.info(input.connId ? "updated storage connection" : "created storage connection", { connId, bucket: input.bucket });
			return { connection: toRuntimeStorageConnection(saved, await hasStoredCredential(connId)) };
		},

		async deleteConnection(scope, input) {
			const connId = normalizeConnId(input.connId);
			let deleted = false;
			await mutateWorkspaceStorageConnections(scope.workspaceId, (current) => {
				const next = current.filter((r) => normalizeConnId(r.connId) !== connId);
				deleted = next.length !== current.length;
				return next;
			});
			if (deleted) {
				await mutateStorageCredential(connId, () => undefined);
				log.info("deleted storage connection", { connId });
			}
			return { deleted };
		},

		async testConnection(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).testConnection(input.connId);
		},

		async listObjects(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).listObjects(input.connId, {
				prefix: input.prefix,
				continuationToken: input.continuationToken,
				maxKeys: input.maxKeys,
			});
		},

		async readObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).readObject(input.connId, input.key);
		},

		async statObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).statObject(input.connId, input.key);
		},

		async downloadObject(scope, input) {
			return await getWorkspaceStorageService(scope.workspaceId).downloadObject(input.connId, input.key);
		},
	};
}
