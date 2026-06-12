import { frontmatterString, type VaultDoc } from "../data/vault-doc-model";
import type { VaultTypeView } from "../data/vault-type-registry";

export interface VaultBoardColumn {
	id: string;
	title: string;
}

export interface GroupedBoard {
	columns: VaultBoardColumn[];
	cardsByColumn: Record<string, VaultDoc[]>;
}

/**
 * Group documents into board columns by their `status` frontmatter. Columns come
 * from the type's status enum (type-generic from day one). Documents with a
 * missing or unknown status fall into the first column. Within a column, cards
 * are ordered by `updatedAt` descending (fractional ranking is deferred).
 */
export function groupDocsByStatus(view: VaultTypeView, docs: VaultDoc[]): GroupedBoard {
	const columns: VaultBoardColumn[] = view.statuses.map((status) => ({ id: status.value, title: status.label }));
	const cardsByColumn: Record<string, VaultDoc[]> = {};
	for (const column of columns) {
		cardsByColumn[column.id] = [];
	}

	const fallbackColumnId = columns[0]?.id;
	for (const doc of docs) {
		const status = frontmatterString(doc, view.statusKey);
		const bucket =
			cardsByColumn[status] ?? (fallbackColumnId !== undefined ? cardsByColumn[fallbackColumnId] : undefined);
		bucket?.push(doc);
	}

	for (const bucket of Object.values(cardsByColumn)) {
		bucket.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	return { columns, cardsByColumn };
}
