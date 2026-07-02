import { HardDrive } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * Top-bar Storage control: a toggle button that opens/closes the Storage surface.
 * Toggle-only (no agent-access popover) because there is no agent S3 read path yet.
 * Mirrors the left half of {@link DatabaseControlButton} — same size, same variant
 * logic, same ring when open.
 */
export function StorageControlButton({
	isStorageOpen,
	onToggleStorage,
}: {
	isStorageOpen: boolean;
	onToggleStorage: () => void;
}): React.ReactElement {
	return (
		<div className={cn("flex shrink-0 rounded-md", isStorageOpen && "ring-1 ring-accent")}>
			<Button
				variant={isStorageOpen ? "primary" : "default"}
				size="sm"
				icon={<HardDrive size={14} />}
				onClick={onToggleStorage}
				className={cn(!isStorageOpen && "kb-navbar-btn")}
				title="Object storage"
			>
				Storage
			</Button>
		</div>
	);
}
