import { Database } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type {
	RuntimeDbConnection,
	RuntimeDbTable,
	RuntimeDbTestConnectionRequest,
	RuntimeDbUpsertConnectionRequest,
} from "@/runtime/types";
import { ConnectionDialog } from "./connection-dialog";
import { DatabaseSidebar } from "./database-sidebar";
import { dbErrorMessage } from "./db-utils";
import { TableDataPanel } from "./table-data-panel";
import { useDbConnections } from "./use-db-connections";
import { useDbIntrospection } from "./use-db-introspection";

export interface DatabaseViewProps {
	workspaceId: string | null;
}

interface DialogState {
	open: boolean;
	connection: RuntimeDbConnection | null;
}

/**
 * The human-side Database surface: a full-view shell (mirrors VaultView, opened from the top bar —
 * no route). Left rail manages connections + the lazy structure tree; the main area browses and
 * inline-edits the selected table's data. All data flows through the self-contained `database` tRPC
 * router, not the workspace-state payload.
 */
export function DatabaseView({ workspaceId }: DatabaseViewProps): React.ReactElement {
	const connections = useDbConnections(workspaceId);
	const introspection = useDbIntrospection(workspaceId);

	const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
	const [selectedTable, setSelectedTable] = useState<RuntimeDbTable | null>(null);
	const [dialog, setDialog] = useState<DialogState>({ open: false, connection: null });
	const [deletingConnection, setDeletingConnection] = useState<RuntimeDbConnection | null>(null);

	const { upsertConnection, deleteConnection, testConnection } = connections;
	const { forget, reload: reloadIntrospection, ensureLoaded } = introspection;

	const selectedConnection = useMemo(
		() => connections.connections.find((c) => c.connId === selectedConnId) ?? null,
		[connections.connections, selectedConnId],
	);

	const handleSelectTable = useCallback((connId: string, table: RuntimeDbTable) => {
		setSelectedConnId(connId);
		setSelectedTable(table);
	}, []);

	const handleSave = useCallback(
		async (request: RuntimeDbUpsertConnectionRequest) => {
			const connection = await upsertConnection(request);
			// Re-introspect on next expand so a changed host/db/credential is reflected.
			forget(connection.connId);
		},
		[upsertConnection, forget],
	);

	const handleTest = useCallback(
		(request: RuntimeDbTestConnectionRequest) => testConnection(request),
		[testConnection],
	);

	const handleConfirmDeleteConnection = useCallback(async () => {
		if (!deletingConnection) {
			return;
		}
		const { connId, label } = deletingConnection;
		setDeletingConnection(null);
		try {
			await deleteConnection(connId);
			forget(connId);
			if (selectedConnId === connId) {
				setSelectedConnId(null);
				setSelectedTable(null);
			}
			showAppToast({ intent: "success", message: `Removed “${label}”.` });
		} catch (error) {
			showAppToast({ intent: "danger", message: dbErrorMessage(error, "Failed to delete connection.") });
		}
	}, [deletingConnection, deleteConnection, forget, selectedConnId]);

	const selectedTableKey = selectedTable ? `${selectedTable.schema}.${selectedTable.name}` : null;

	if (!workspaceId) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 text-[13px] text-text-tertiary">
				Select a project to manage databases.
			</div>
		);
	}

	return (
		<div className="flex flex-1 min-h-0">
			<DatabaseSidebar
				connections={connections.connections}
				isLoading={connections.isLoading}
				errorMessage={connections.errorMessage}
				introspectionStateByConnId={introspection.stateByConnId}
				selectedConnId={selectedConnId}
				selectedTableKey={selectedTableKey}
				onAddConnection={() => setDialog({ open: true, connection: null })}
				onEditConnection={(connection) => setDialog({ open: true, connection })}
				onDeleteConnection={(connection) => setDeletingConnection(connection)}
				onEnsureIntrospection={ensureLoaded}
				onReloadIntrospection={reloadIntrospection}
				onSelectTable={handleSelectTable}
			/>

			{selectedConnection && selectedTable ? (
				<TableDataPanel
					key={`${selectedConnection.connId}:${selectedTableKey}`}
					workspaceId={workspaceId}
					connection={selectedConnection}
					table={selectedTable}
				/>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-0 text-text-tertiary">
					<Database size={32} className="opacity-40" />
					<div className="text-[13px]">
						{connections.connections.length === 0
							? "Add a database connection to begin."
							: "Select a table to browse its data."}
					</div>
					{connections.connections.length === 0 ? (
						<Button variant="primary" size="sm" onClick={() => setDialog({ open: true, connection: null })}>
							Add connection
						</Button>
					) : null}
				</div>
			)}

			{dialog.open ? (
				<ConnectionDialog
					open={dialog.open}
					connection={dialog.connection}
					isSaving={connections.isMutating}
					onClose={() => setDialog({ open: false, connection: null })}
					onSave={handleSave}
					onTest={handleTest}
				/>
			) : null}

			<AlertDialog
				open={deletingConnection !== null}
				onOpenChange={(next) => (next ? undefined : setDeletingConnection(null))}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove this connection?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This removes the connection <strong>{deletingConnection?.label}</strong> and its stored credentials from
						this machine. The database itself is not affected.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setDeletingConnection(null)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<Button variant="danger" onClick={() => void handleConfirmDeleteConnection()}>
						Remove
					</Button>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
