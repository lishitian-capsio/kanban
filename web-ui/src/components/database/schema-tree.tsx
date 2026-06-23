import { ChevronDown, ChevronRight, Eye, KeyRound, Table2 } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeDbTable } from "@/runtime/types";
import type { IntrospectionState } from "./use-db-introspection";

interface SchemaGroup {
	schema: string;
	tables: RuntimeDbTable[];
}

function groupBySchema(tables: RuntimeDbTable[]): SchemaGroup[] {
	const order: string[] = [];
	const bySchema = new Map<string, RuntimeDbTable[]>();
	for (const table of tables) {
		const existing = bySchema.get(table.schema);
		if (existing) {
			existing.push(table);
		} else {
			bySchema.set(table.schema, [table]);
			order.push(table.schema);
		}
	}
	return order.map((schema) => ({ schema, tables: bySchema.get(schema) ?? [] }));
}

export interface SchemaTreeProps {
	introspection: IntrospectionState | undefined;
	selectedTableKey: string | null;
	onSelectTable: (table: RuntimeDbTable) => void;
}

/** The lazy connection→schema→table/view→column structure tree for a single connection. */
export function SchemaTree({ introspection, selectedTableKey, onSelectTable }: SchemaTreeProps): React.ReactElement {
	const groups = useMemo(() => groupBySchema(introspection?.data?.tables ?? []), [introspection?.data?.tables]);

	if (!introspection || introspection.status === "loading") {
		return (
			<div className="flex items-center gap-2 pl-7 pr-2 py-1.5 text-[12px] text-text-tertiary">
				<Spinner size={12} /> Loading schema…
			</div>
		);
	}
	if (introspection.status === "error") {
		return <div className="pl-7 pr-2 py-1.5 text-[12px] text-status-red">{introspection.errorMessage}</div>;
	}
	if (groups.length === 0) {
		return <div className="pl-7 pr-2 py-1.5 text-[12px] text-text-tertiary">No tables.</div>;
	}

	const singleUnnamedSchema = groups.length === 1 && groups[0]?.schema.trim() === "";
	return (
		<div>
			{groups.map((group) =>
				singleUnnamedSchema ? (
					<TableList
						key={group.schema || "__default__"}
						tables={group.tables}
						depth={1}
						selectedTableKey={selectedTableKey}
						onSelectTable={onSelectTable}
					/>
				) : (
					<SchemaNode
						key={group.schema}
						group={group}
						selectedTableKey={selectedTableKey}
						onSelectTable={onSelectTable}
					/>
				),
			)}
		</div>
	);
}

function SchemaNode({
	group,
	selectedTableKey,
	onSelectTable,
}: {
	group: SchemaGroup;
	selectedTableKey: string | null;
	onSelectTable: (table: RuntimeDbTable) => void;
}): React.ReactElement {
	const [expanded, setExpanded] = useState(true);
	return (
		<div>
			<TreeRow depth={1} onClick={() => setExpanded((value) => !value)}>
				{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
				<span className="truncate text-text-secondary">{group.schema}</span>
				<span className="ml-auto text-[11px] text-text-tertiary">{group.tables.length}</span>
			</TreeRow>
			{expanded ? (
				<TableList
					tables={group.tables}
					depth={2}
					selectedTableKey={selectedTableKey}
					onSelectTable={onSelectTable}
				/>
			) : null}
		</div>
	);
}

function TableList({
	tables,
	depth,
	selectedTableKey,
	onSelectTable,
}: {
	tables: RuntimeDbTable[];
	depth: number;
	selectedTableKey: string | null;
	onSelectTable: (table: RuntimeDbTable) => void;
}): React.ReactElement {
	return (
		<div>
			{tables.map((table) => (
				<TableNode
					key={`${table.schema}.${table.name}`}
					table={table}
					depth={depth}
					selected={selectedTableKey === `${table.schema}.${table.name}`}
					onSelectTable={onSelectTable}
				/>
			))}
		</div>
	);
}

function TableNode({
	table,
	depth,
	selected,
	onSelectTable,
}: {
	table: RuntimeDbTable;
	depth: number;
	selected: boolean;
	onSelectTable: (table: RuntimeDbTable) => void;
}): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	return (
		<div>
			<TreeRow depth={depth} active={selected} onClick={() => onSelectTable(table)}>
				<button
					type="button"
					className="flex items-center text-text-tertiary hover:text-text-secondary"
					onClick={(event) => {
						event.stopPropagation();
						setExpanded((value) => !value);
					}}
					aria-label={expanded ? "Collapse columns" : "Expand columns"}
				>
					{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
				</button>
				{table.kind === "view" ? <Eye size={13} className="text-status-purple" /> : <Table2 size={13} className="text-status-blue" />}
				<span className="truncate">{table.name}</span>
			</TreeRow>
			{expanded ? (
				<div>
					{table.columns.map((column) => (
						<div
							key={column.name}
							className="flex items-center gap-1.5 py-0.5 pr-2 text-[12px] text-text-tertiary"
							style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
						>
							{column.isPrimaryKey ? (
								<KeyRound size={11} className="text-status-gold shrink-0" />
							) : (
								<span className="w-[11px] shrink-0" />
							)}
							<span className="truncate text-text-secondary">{column.name}</span>
							<span className="ml-auto truncate text-[11px] text-text-tertiary">{column.dataType}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

function TreeRow({
	depth,
	active = false,
	onClick,
	children,
}: {
	depth: number;
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-1.5 py-1 pr-2 text-[13px] text-left",
				active ? "bg-surface-3 text-text-primary" : "text-text-primary hover:bg-surface-2",
			)}
			style={{ paddingLeft: `${depth * 16 + 8}px` }}
		>
			{children}
		</button>
	);
}
