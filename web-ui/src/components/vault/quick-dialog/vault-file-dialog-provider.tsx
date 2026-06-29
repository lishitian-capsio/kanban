import type React from "react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { type OpenVaultFile, VaultFileDialogContext } from "./use-vault-file-dialog";
import { VaultFileDialog } from "./vault-file-dialog";

interface VaultFileDialogState {
	open: boolean;
	fileId: string | null;
	workspaceId: string | null;
}

const CLOSED: VaultFileDialogState = { open: false, fileId: null, workspaceId: null };

/**
 * Mounts ONE quick dialog as a portaled sibling of the app content and exposes
 * the stable `openVaultFile` opener via context.
 *
 * The board never re-renders when the dialog opens: the open state lives in
 * THIS component's fiber, and `children` is passed through by reference — when
 * the provider re-renders on open, React keeps the same `children` element and
 * bails out of re-rendering the board subtree (the project's "high-frequency
 * state stays in the leaf fiber that shows it" rule; here the leaf is the
 * dialog). The context value is only the opener, so consumers that read it
 * never re-render on open/close either.
 */
export function VaultFileDialogProvider({
	workspaceId,
	children,
}: {
	/** Default workspace for files opened without an explicit `workspaceId`. */
	workspaceId: string | null;
	children: ReactNode;
}): React.ReactElement {
	const [state, setState] = useState<VaultFileDialogState>(CLOSED);

	const openVaultFile = useCallback<OpenVaultFile>(
		(fileId, options) => {
			setState({ open: true, fileId, workspaceId: options?.workspaceId ?? workspaceId });
		},
		[workspaceId],
	);

	const handleClose = useCallback(() => {
		setState((prev) => ({ ...prev, open: false }));
	}, []);

	// `openVaultFile` is the sole context value, and only changes when the
	// default workspace changes (low frequency) — never on open/close.
	const contextValue = useMemo(() => openVaultFile, [openVaultFile]);

	return (
		<VaultFileDialogContext.Provider value={contextValue}>
			{children}
			<VaultFileDialog
				open={state.open}
				fileId={state.fileId}
				workspaceId={state.workspaceId}
				onClose={handleClose}
			/>
		</VaultFileDialogContext.Provider>
	);
}
