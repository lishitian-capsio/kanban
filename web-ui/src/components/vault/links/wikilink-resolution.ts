import type { RuntimeVaultOutgoingLink } from "@/runtime/types";

/** A `[[target]]` that the B1 engine matched to a concrete document. */
export interface WikilinkResolution {
	id: string;
	type: string;
	title: string;
}

/** Looks a `[[target]]` up to its document, or null when unresolved. */
export type WikilinkResolver = (target: string) => WikilinkResolution | null;

function normalize(target: string): string {
	return target.trim().toLowerCase();
}

/**
 * Turn the `outgoing` links the backend engine reported for a document into a
 * fast target → resolution lookup. The frontend never re-derives resolution
 * (title → alias → slug) itself — it only indexes what `getDocumentLinks`
 * already resolved. Both the written target and the resolved title are keyed so a
 * link written through an alias still lights up by its canonical title.
 */
export function buildWikilinkResolver(outgoing: RuntimeVaultOutgoingLink[]): WikilinkResolver {
	const byTarget = new Map<string, WikilinkResolution>();
	for (const link of outgoing) {
		if (link.resolvedId === null || link.resolvedType === null || link.resolvedTitle === null) {
			continue;
		}
		const resolution: WikilinkResolution = {
			id: link.resolvedId,
			type: link.resolvedType,
			title: link.resolvedTitle,
		};
		byTarget.set(normalize(link.target), resolution);
		byTarget.set(normalize(link.resolvedTitle), resolution);
	}
	return (target) => byTarget.get(normalize(target)) ?? null;
}
