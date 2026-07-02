import { HardDrive, Pencil, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeStorageConnection } from "@/runtime/types";
import { StorageConnectionDialog } from "./storage-connection-dialog";
import type { UseStorageConnectionsResult } from "./use-storage-connections";

export interface StorageSidebarProps {
	workspaceId: string | null;
	connections: UseStorageConnectionsResult;
	selectedConnId: string | null;
	onSelectConn: (connId: string) => void;
	/** When true, opens the Add connection dialog (from an external CTA). */
	externalOpenAdd?: boolean;
	/** Called after the external add-dialog open has been handled. */
	onExternalOpenAddHandled?: () => void;
}

export function StorageSidebar({
	workspaceId: _workspaceId,
	connections,
	selectedConnId,
	onSelectConn,
	externalOpenAdd,
	onExternalOpenAddHandled,
}: StorageSidebarProps): React.ReactElement {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingConnection, setEditingConnection] = useState<RuntimeStorageConnection | null>(null);
	const [deletingConnection, setDeletingConnection] = useState<RuntimeStorageConnection | null>(null);

	const { connections: list, isLoading, errorMessage, isMutating, upsertConnection, deleteConnection, testConnection } = connections;

	// Handle external "Add" trigger from the empty-state CTA.
	useEffect(() => {
		if (externalOpenAdd) {
			setEditingConnection(null);
			setDialogOpen(true);
			onExternalOpenAddHandled?.();
		}
	}, [externalOpenAdd, onExternalOpenAddHandled]);

	const handleAdd = useCallback(() => {
		setEditingConnection(null);
		setDialogOpen(true);
	}, []);

	const handleEdit = useCallback((connection: RuntimeStorageConnection) => {
		setEditingConnection(connection);
		setDialogOpen(true);
	}, []);

	const handleCloseDialog = useCallback(() => {
		setDialogOpen(false);
		setEditingConnection(null);
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		if (!deletingConnection) {
			return;
		}
		const { connId, label } = deletingConnection;
		setDeletingConnection(null);
		try {
			await deleteConnection(connId);
			if (selectedConnId === connId) {
				onSelectConn("");
			}
			showAppToast({ intent: "success", message: `Removed "${label}".` });
		} catch (error) {
			showAppToast({
				intent: "danger",
				message: error instanceof Error ? error.message : "Failed to delete connection.",
			});
		}
	}, [deletingConnection, deleteConnection, selectedConnId, onSelectConn]);

	return (
		<div className="flex w-64 shrink-0 flex-col border-r border-border bg-surface-1 min-h-0">
			<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
				<span className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">Connections</span>
				<Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={handleAdd} title="Add connection">
					Add
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto overscroll-contain min-h-0 py-1">
				{isLoading && list.length === 0 ? (
					<div className="flex items-center gap-2 px-3 py-2 text-[12px] text-text-tertiary">
						<Spinner size={12} /> Loading…
					</div>
				) : null}
				{errorMessage ? (
					<div className="px-3 py-2 text-[12px] text-status-red">{errorMessage}</div>
				) : null}
				{!isLoading && list.length === 0 && !errorMessage ? (
					<div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
						No connections yet. Add one to get started.
					</div>
				) : null}
				{list.map((connection) => (
					<div
						key={connection.connId}
						className={cn(
							"group flex items-center gap-2 px-2 py-1.5 cursor-pointer",
							selectedConnId === connection.connId ? "bg-surface-2" : "hover:bg-surface-2",
						)}
						onClick={() => onSelectConn(connection.connId)}
					>
						<HardDrive size={14} className="text-text-tertiary shrink-0" />
						<span className="truncate text-[13px] text-text-primary flex-1">{connection.label}</span>
						<div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
							<IconAction label="Edit" onClick={() => handleEdit(connection)}>
								<Pencil size={13} />
							</IconAction>
							<IconAction label="Delete" danger onClick={() => setDeletingConnection(connection)}>
								<Trash2 size={13} />
							</IconAction>
						</div>
					</div>
				))}
			</div>

			{dialogOpen ? (
				<StorageConnectionDialog
					open={dialogOpen}
					connection={editingConnection}
					isSaving={isMutating}
					onClose={handleCloseDialog}
					onSave={upsertConnection}
					onTest={testConnection}
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
						this machine. The bucket itself is not affected.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setDeletingConnection(null)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<Button variant="danger" onClick={() => void handleConfirmDelete()}>
						Remove
					</Button>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}

function IconAction({
	label,
	danger = false,
	onClick,
	children,
}: {
	label: string;
	danger?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				aria-label={label}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
				className={cn(
					"flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-3",
					danger ? "hover:text-status-red" : "hover:text-text-primary",
				)}
			>
				{children}
			</button>
		</Tooltip>
	);
}
