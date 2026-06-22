import { describe, expect, it, vi } from "vitest";

import {
	type DependencyGeometryCacheEntry,
	type DependencyGeometryInputs,
	resolveCachedDependencyGeometry,
} from "@/components/dependencies/dependency-overlay";
import type { BoardColumnId } from "@/types";

function makeInputs(overrides: Partial<DependencyGeometryInputs> = {}): DependencyGeometryInputs {
	const columnId: BoardColumnId = "backlog";
	return {
		sourceAnchor: { left: 0, right: 100, top: 0, bottom: 40, centerX: 50, centerY: 20, columnId },
		targetAnchor: { left: 300, right: 400, top: 200, bottom: 240, centerX: 350, centerY: 220, columnId },
		sourceLaneOffset: 0,
		targetLaneOffset: 0,
		width: 1000,
		height: 800,
		...overrides,
	};
}

describe("resolveCachedDependencyGeometry", () => {
	it("recomputes on first render and writes the result into the next cache", () => {
		const previousCache = new Map<string, DependencyGeometryCacheEntry>();
		const nextCache = new Map<string, DependencyGeometryCacheEntry>();
		const inputs = makeInputs();
		const compute = vi.fn((i: DependencyGeometryInputs) => ({
			geometry: {} as never,
			path: `${i.sourceAnchor.left}->${i.targetAnchor.left}`,
			midpointX: 0,
			midpointY: 0,
			startSide: "right" as const,
			endSide: "left" as const,
		}));

		const result = resolveCachedDependencyGeometry(previousCache, nextCache, "edge-1", inputs, compute);

		expect(compute).toHaveBeenCalledTimes(1);
		expect(nextCache.get("edge-1")?.result).toBe(result);
	});

	it("reuses the cached result when the anchors, lane offsets, and bounds are unchanged", () => {
		const inputs = makeInputs();
		const compute = vi.fn(() => ({
			geometry: {} as never,
			path: "stable",
			midpointX: 0,
			midpointY: 0,
			startSide: "right" as const,
			endSide: "left" as const,
		}));

		// First render seeds the cache.
		const firstCache = new Map<string, DependencyGeometryCacheEntry>();
		const firstResult = resolveCachedDependencyGeometry(new Map(), firstCache, "edge-1", inputs, compute);

		// Second render with fresh-but-equal anchor objects (mirrors a new layout object whose
		// individual anchor values did not move) must reuse the cached geometry by reference.
		const secondCache = new Map<string, DependencyGeometryCacheEntry>();
		const secondResult = resolveCachedDependencyGeometry(firstCache, secondCache, "edge-1", makeInputs(), compute);

		expect(compute).toHaveBeenCalledTimes(1);
		expect(secondResult).toBe(firstResult);
	});

	it("recomputes only the edge whose anchor actually moved", () => {
		const computeStable = vi.fn(() => ({
			geometry: {} as never,
			path: "stable",
			midpointX: 0,
			midpointY: 0,
			startSide: "right" as const,
			endSide: "left" as const,
		}));
		const computeMoved = vi.fn(() => ({
			geometry: {} as never,
			path: "moved",
			midpointX: 0,
			midpointY: 0,
			startSide: "right" as const,
			endSide: "left" as const,
		}));

		// Seed two edges.
		const firstCache = new Map<string, DependencyGeometryCacheEntry>();
		resolveCachedDependencyGeometry(new Map(), firstCache, "stable", makeInputs(), computeStable);
		resolveCachedDependencyGeometry(new Map(), firstCache, "moved", makeInputs(), computeMoved);
		expect(computeStable).toHaveBeenCalledTimes(1);
		expect(computeMoved).toHaveBeenCalledTimes(1);

		// Re-render where only the "moved" edge's source anchor shifted.
		const secondCache = new Map<string, DependencyGeometryCacheEntry>();
		resolveCachedDependencyGeometry(firstCache, secondCache, "stable", makeInputs(), computeStable);
		resolveCachedDependencyGeometry(
			firstCache,
			secondCache,
			"moved",
			makeInputs({
				sourceAnchor: { left: 10, right: 110, top: 5, bottom: 45, centerX: 60, centerY: 25, columnId: "backlog" },
			}),
			computeMoved,
		);

		expect(computeStable).toHaveBeenCalledTimes(1); // unchanged edge reused its cached geometry
		expect(computeMoved).toHaveBeenCalledTimes(2); // moved edge recomputed
	});

	it("recomputes when the lane offset or overlay bounds change", () => {
		const compute = vi.fn(() => ({
			geometry: {} as never,
			path: "p",
			midpointX: 0,
			midpointY: 0,
			startSide: "right" as const,
			endSide: "left" as const,
		}));

		const firstCache = new Map<string, DependencyGeometryCacheEntry>();
		resolveCachedDependencyGeometry(new Map(), firstCache, "edge-1", makeInputs(), compute);

		const laneCache = new Map<string, DependencyGeometryCacheEntry>();
		resolveCachedDependencyGeometry(firstCache, laneCache, "edge-1", makeInputs({ sourceLaneOffset: 9 }), compute);
		expect(compute).toHaveBeenCalledTimes(2);

		const boundsCache = new Map<string, DependencyGeometryCacheEntry>();
		resolveCachedDependencyGeometry(
			laneCache,
			boundsCache,
			"edge-1",
			makeInputs({ sourceLaneOffset: 9, width: 1200 }),
			compute,
		);
		expect(compute).toHaveBeenCalledTimes(3);
	});
});
