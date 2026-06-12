import { frontmatterString, type VaultDoc } from "../data/vault-doc-model";

/**
 * Helpers for the customer anchor (客户 → 需求). A requirement references its
 * customer through a `customer` frontmatter wikilink (`[[Customer Name]]`,
 * Obsidian/tolaria-style), and a customer pins supporting files via a `materials`
 * array of file-library ids. These pure functions encode that relationship so the
 * picker, backlinks, and materials UI stay trivially testable.
 */

const WIKILINK = /^\s*\[\[(.+?)\]\]\s*$/;

const MATERIALS_KEY = "materials";

/** Extract `Target` from `[[Target]]`, or null when the value is not a wikilink. */
export function parseWikilinkTarget(value: string): string | null {
	const match = WIKILINK.exec(value);
	const target = match?.[1]?.trim();
	return target ? target : null;
}

/** The frontmatter value stored when a requirement is linked to a customer. */
export function customerRefValue(customer: VaultDoc): string {
	return `[[${customer.name}]]`;
}

/** Human-readable label for a stored customer ref ("" when unset). */
export function customerRefLabel(value: string | null | undefined): string {
	if (!value) {
		return "";
	}
	return parseWikilinkTarget(value) ?? value;
}

/** Does a stored customer ref point at this customer doc? Matches by name. */
export function refMatchesCustomer(refValue: string, customer: VaultDoc): boolean {
	const target = (parseWikilinkTarget(refValue) ?? refValue).trim().toLowerCase();
	if (!target) {
		return false;
	}
	return target === customer.name.trim().toLowerCase();
}

/** Resolve a stored customer ref to its customer doc within a list. */
export function resolveCustomerRef(refValue: string, customers: VaultDoc[]): VaultDoc | undefined {
	if (!refValue.trim()) {
		return undefined;
	}
	return customers.find((customer) => refMatchesCustomer(refValue, customer));
}

/** Requirements (or any docs) whose `customer` ref points at this customer. */
export function findCustomerBacklinks(
	customer: VaultDoc,
	candidates: VaultDoc[],
	customerKey = "customer",
): VaultDoc[] {
	return candidates.filter((doc) => {
		const ref = frontmatterString(doc, customerKey);
		return ref ? refMatchesCustomer(ref, customer) : false;
	});
}

/** Read a customer's pinned file-library material ids (string entries only). */
export function readMaterialIds(doc: VaultDoc, key = MATERIALS_KEY): string[] {
	const value = doc.frontmatter[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}
