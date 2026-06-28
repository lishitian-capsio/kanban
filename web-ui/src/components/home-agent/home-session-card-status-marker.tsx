// The shared status-slot glyph for the fullscreen home surfaces, mirroring the
// board task card's header marker: a real spinner while running, a red
// alert-circle on failure, an orange alert-triangle for a credit-limit error,
// and a plain colored dot for the quiet states. The accessible name is expected
// to live on the wrapping element, so the glyphs are `aria-hidden`.
//
// Extracted from home-session-card.tsx so the Task tab's active-task rows render
// the identical status semantics without duplicating the switch.
import { AlertCircle, AlertTriangle } from "lucide-react";
import type { ReactElement } from "react";

import type { HomeSessionCardStatusDescriptor } from "@/components/home-agent/home-session-card-derive";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";

export function HomeSessionCardStatusMarker({
	status,
}: {
	status: HomeSessionCardStatusDescriptor;
}): ReactElement {
	switch (status.marker) {
		case "spinner":
			return <Spinner size={12} className={status.markerClassName || undefined} />;
		case "alert-circle":
			return <AlertCircle size={12} className={status.markerClassName} aria-hidden="true" />;
		case "alert-triangle":
			return <AlertTriangle size={12} className={status.markerClassName} aria-hidden="true" />;
		default:
			return (
				<span
					aria-hidden="true"
					className={cn("size-2 rounded-full", status.markerClassName, status.pulse && "animate-pulse")}
				/>
			);
	}
}
