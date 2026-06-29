import { createContext, useContext } from "react";

export interface OpenVaultFileOptions {
	/** Workspace the file lives in. Defaults to the provider's current workspace. */
	workspaceId?: string;
}

/** Opens the single-file quick dialog for a vault file `id`. Stable reference. */
export type OpenVaultFile = (fileId: string, options?: OpenVaultFileOptions) => void;

/**
 * Context value is the stable `openVaultFile` opener — nothing else. Consumers
 * that only need to open a file never re-render when the dialog opens/closes
 * (the open state lives inside the provider's own fiber, see
 * `VaultFileDialogProvider`).
 */
export const VaultFileDialogContext = createContext<OpenVaultFile | null>(null);

/**
 * The seam every trigger uses: `const open = useOpenVaultFile(); open(id)`.
 * Throws when no provider is mounted so a miswired trigger fails loudly rather
 * than silently doing nothing.
 */
export function useOpenVaultFile(): OpenVaultFile {
	const open = useContext(VaultFileDialogContext);
	if (!open) {
		throw new Error("useOpenVaultFile must be used within a <VaultFileDialogProvider>.");
	}
	return open;
}
