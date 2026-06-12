import { parseFrontmatter } from "../data/frontmatter";
import type { CreateVaultDocInput } from "../data/use-vault-docs";
import type { VaultTypeView } from "../data/vault-type-registry";

/**
 * Turn a type's markdown template into a create request. The template carries both
 * the starter frontmatter and body; `parseFrontmatter` splits them so a new type
 * is just a template string ("新建走 markdown 模板").
 */
export function buildDocFromTemplate(view: VaultTypeView, title: string): CreateVaultDocInput {
	const { frontmatter, body } = parseFrontmatter(view.template);
	return {
		type: view.type,
		title,
		body: body.trimStart(),
		frontmatter,
	};
}
