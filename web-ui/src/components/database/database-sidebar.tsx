import { ChevronDown, ChevronRight, Lock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeDbConnection, RuntimeDbEngine, RuntimeDbTable } from "@/runtime/types";
import { SchemaTree } from "./schema-tree";
import type { IntrospectionState } from "./use-db-introspection";

const ENGINE_TAG: Record<RuntimeDbEngine, string> = {
	postgres: "PG",
	cockroachdb: "CR",
	timescaledb: "TS",
	mysql: "MY",
	mariadb: "MA",
	sqlite: "SL",
	redis: "RD",
};

export interface DatabaseSidebarProps {
	connections: RuntimeDbConnection[];
	isLoading: boolean;
	errorMessage: string | null;
	introspectionStateByConnId: Record<string, IntrospectionState>;
	selectedConnId: string | null;
	selectedTableKey: string | null;
	onAddConnection: () => void;
	onEditConnection: (connection: RuntimeDbConnection) => void;
	onDeleteConnection: (connection: RuntimeDbConnection) => void;
	onEnsureIntrospection: (connId: string) => void;
	onReloadIntrospection: (connId: string) => void;
	onSelectTable: (connId: string, table: RuntimeDbTable) => void;
	/** Pinned to the bottom of the rail, below the scrollable connections list. */
	footer?: React.ReactNode;
}

export function DatabaseSidebar({
	connections,
	isLoading,
	errorMessage,
	introspectionStateByConnId,
	selectedConnId,
	selectedTableKey,
	onAddConnection,
	onEditConnection,
	onDeleteConnection,
	onEnsureIntrospection,
	onReloadIntrospection,
	onSelectTable,
	footer,
}: DatabaseSidebarProps): React.ReactElement {
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const toggleExpanded = useCallback(
		(connId: string) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(connId)) {
					next.delete(connId);
				} else {
					next.add(connId);
					onEnsureIntrospection(connId);
				}
				return next;
			});
		},
		[onEnsureIntrospection],
	);

	return (
		<div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface-1 min-h-0">
			<div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
				<span className="text-[12px] font-semibold uppercase tracking-wide text-text-secondary">Connections</span>
				<Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={onAddConnection} title="Add connection">
					Add
				</Button>
			</div>
			<div className="flex-1 overflow-y-auto overscroll-contain min-h-0 py-1">
				{isLoading && connections.length === 0 ? (
					<div className="flex items-center gap-2 px-3 py-2 text-[12px] text-text-tertiary">
						<Spinner size={12} /> Loading…
					</div>
				) : null}
				{errorMessage ? <div className="px-3 py-2 text-[12px] text-status-red">{errorMessage}</div> : null}
				{!isLoading && connections.length === 0 && !errorMessage ? (
					<div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
						No connections yet. Add one to get started.
					</div>
				) : null}
				{connections.map((connection) => {
					const isExpanded = expanded.has(connection.connId);
					return (
						<div key={connection.connId}>
							<div
								className={cn(
									"group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer",
									selectedConnId === connection.connId ? "bg-surface-2" : "hover:bg-surface-2",
								)}
								onClick={() => toggleExpanded(connection.connId)}
							>
								{isExpanded ? (
									<ChevronDown size={14} className="text-text-tertiary shrink-0" />
								) : (
									<ChevronRight size={14} className="text-text-tertiary shrink-0" />
								)}
								<span className="flex h-4 min-w-[22px] items-center justify-center rounded-sm bg-surface-3 px-1 text-[10px] font-semibold text-text-secondary shrink-0">
									{ENGINE_TAG[connection.engine]}
								</span>
								<span className="truncate text-[13px] text-text-primary">{connection.label}</span>
								{!connection.allowWrites ? (
									<Tooltip content="Read-only">
										<Lock size={11} className="text-text-tertiary shrink-0" />
									</Tooltip>
								) : null}
								<div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
									<IconAction
										label="Refresh schema"
										onClick={() => onReloadIntrospection(connection.connId)}
									>
										<RefreshCw size={13} />
									</IconAction>
									<IconAction label="Edit" onClick={() => onEditConnection(connection)}>
										<Pencil size={13} />
									</IconAction>
									<IconAction label="Delete" danger onClick={() => onDeleteConnection(connection)}>
										<Trash2 size={13} />
									</IconAction>
								</div>
							</div>
							{isExpanded ? (
								<SchemaTree
									introspection={introspectionStateByConnId[connection.connId]}
									selectedTableKey={selectedConnId === connection.connId ? selectedTableKey : null}
									onSelectTable={(table) => onSelectTable(connection.connId, table)}
								/>
							) : null}
						</div>
					);
				})}
			</div>
			{footer}
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
				onClick={(event) => {
					event.stopPropagation();
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
