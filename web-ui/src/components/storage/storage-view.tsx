import { HardDrive } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { StorageObjectBrowser } from "./storage-object-browser";
import { StorageObjectViewer } from "./storage-object-viewer";
import { StorageSidebar } from "./storage-sidebar";
import { useStorageConnections } from "./use-storage-connections";
import { useStorageObject } from "./use-storage-object";
import { useStorageTree } from "./use-storage-tree";

export interface StorageViewProps {
	workspaceId: string | null;
}

/**
 * The human-side Storage surface: a full-view shell mirroring DatabaseView.
 * Left rail manages connections; the right pane browses objects and previews
 * selected content. All data flows through the self-contained `storage` tRPC
 * router.
 */
export function StorageView({ workspaceId }: StorageViewProps): React.ReactElement {
	const connections = useStorageConnections(workspaceId);
	const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	/** Imperative trigger to open the "Add connection" dialog inside the sidebar. */
	const [openAddDialog, setOpenAddDialog] = useState(false);

	const tree = useStorageTree(workspaceId, selectedConnId);
	const objectQuery = useStorageObject(workspaceId, selectedConnId, selectedKey);

	const handleSelectConn = useCallback((connId: string) => {
		setSelectedConnId(connId || null);
		setSelectedKey(null);
	}, []);

	const handleRequestAdd = useCallback(() => {
		setOpenAddDialog(true);
	}, []);

	const handleAddDialogHandled = useCallback(() => {
		setOpenAddDialog(false);
	}, []);

	if (!workspaceId) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-0 text-[13px] text-text-tertiary">
				Select a project to browse storage.
			</div>
		);
	}

	return (
		<div className="flex flex-1 min-h-0">
			<StorageSidebar
				workspaceId={workspaceId}
				connections={connections}
				selectedConnId={selectedConnId}
				onSelectConn={handleSelectConn}
				externalOpenAdd={openAddDialog}
				onExternalOpenAddHandled={handleAddDialogHandled}
			/>

			{selectedConnId ? (
				<div className="flex flex-col flex-1 min-h-0 min-w-0">
					{/* Object list: takes 40% of height when a key is selected, else full */}
					<div className={selectedKey ? "flex flex-col h-[40%] min-h-0 border-b border-border" : "flex flex-col flex-1 min-h-0"}>
						<StorageObjectBrowser
							tree={tree}
							selectedKey={selectedKey}
							onSelectKey={setSelectedKey}
						/>
					</div>
					{selectedKey ? (
						<div className="flex flex-col flex-1 min-h-0">
							<StorageObjectViewer
								workspaceId={workspaceId}
								connId={selectedConnId}
								objectQuery={objectQuery}
							/>
						</div>
					) : null}
				</div>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-0 text-text-tertiary">
					<HardDrive size={32} className="opacity-40" />
					<div className="text-[13px]">
						{connections.connections.length === 0
							? "Add a storage connection to begin."
							: "Select a connection to browse objects."}
					</div>
					{connections.connections.length === 0 ? (
						<Button variant="primary" size="sm" onClick={handleRequestAdd}>
							Add connection
						</Button>
					) : null}
				</div>
			)}
		</div>
	);
}
