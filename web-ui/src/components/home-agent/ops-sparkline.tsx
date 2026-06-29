import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";

// Tiny inline-SVG sparkline for the sidebar ops status bar. Hand-drawn (no chart
// library) — it only ever plots a few dozen points, so a single <polyline> is
// lighter and simpler than pulling in a dependency. The stroke uses
// `currentColor`, so callers set the color with a Tailwind `text-*` class.

interface OpsSparklineProps {
	/** Samples in oldest → newest order. */
	values: number[];
	width?: number;
	height?: number;
	/** Tailwind text-color class driving the stroke via `currentColor`. */
	className?: string;
}

/** Build the `points` attribute for the polyline, normalizing y to [0, height]. */
function buildPolylinePoints(values: number[], width: number, height: number): string {
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min;
	// Inset by half the stroke width so the line is never clipped at the edges.
	const inset = 0.75;
	const usableHeight = height - inset * 2;
	const lastIndex = values.length - 1;

	return values
		.map((value, index) => {
			const x = lastIndex === 0 ? width : (index / lastIndex) * width;
			// Flat series → draw a centered horizontal line instead of dividing by 0.
			const normalized = range === 0 ? 0.5 : (value - min) / range;
			const y = inset + (1 - normalized) * usableHeight;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

/**
 * A minimal trend line. Renders nothing until there are at least two samples to
 * connect, so the status bar stays clean on a fresh connection.
 */
export function OpsSparkline({ values, width = 36, height = 12, className }: OpsSparklineProps): ReactElement | null {
	if (values.length < 2) {
		return null;
	}

	return (
		<svg
			width={width}
			height={height}
			viewBox={`0 0 ${width} ${height}`}
			fill="none"
			aria-hidden
			className={cn("opacity-70", className)}
			preserveAspectRatio="none"
		>
			<polyline
				points={buildPolylinePoints(values, width, height)}
				fill="none"
				stroke="currentColor"
				strokeWidth={1}
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	);
}
