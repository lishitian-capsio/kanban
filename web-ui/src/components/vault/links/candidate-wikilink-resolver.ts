import type { VaultDoc } from "../data/vault-doc-model";
import type { WikilinkResolution, WikilinkResolver } from "./wikilink-resolution";

function normalize(target: string): string {
	return target.trim().toLowerCase();
}

/**
 * Build a `[[target]]` resolver from a flat candidate pool (every vault doc),
 * keyed by normalized title.
 *
 * Unlike `buildWikilinkResolver` — which indexes a single document's
 * backend-resolved outgoing links — this resolves wikilinks for surfaces that
 * are NOT themselves vault documents (e.g. agent chat markdown), where only the
 * global `listDocuments` pool is available and there is no per-doc link engine
 * result to consult. Title-only matching keeps it lean; full alias/slug
 * resolution stays the backend engine's job for in-vault editing.
 *
 * First title wins on a collision (duplicates are uncommon and a stable,
 * deterministic pick beats silently shadowing), and empty titles are skipped.
 */
export function buildCandidateWikilinkResolver(candidates: VaultDoc[]): WikilinkResolver {
	const byTitle = new Map<string, WikilinkResolution>();
	for (const doc of candidates) {
		const key = normalize(doc.name);
		if (key.length === 0 || byTitle.has(key)) {
			continue;
		}
		byTitle.set(key, { id: doc.id, type: doc.type, title: doc.name });
	}
	return (target) => byTitle.get(normalize(target)) ?? null;
}
