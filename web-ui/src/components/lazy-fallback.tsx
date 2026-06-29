import type { ReactElement } from "react";

import { Spinner } from "@/components/ui/spinner";

// Shared Suspense fallback for lazily-loaded, full-surface views (database,
// vault, git history, card detail, terminal). These views are gated behind
// boolean state / card selection, so their chunks only download when first
// opened; this centered spinner covers the brief fetch+evaluate window.
export function LazyViewFallback(): ReactElement {
	return (
		<div className="flex flex-1 min-h-0 min-w-0 items-center justify-center">
			<Spinner size={20} />
		</div>
	);
}
