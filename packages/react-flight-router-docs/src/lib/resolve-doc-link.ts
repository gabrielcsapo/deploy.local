/**
 * Resolve a relative .md or .mdx link to an absolute /docs/ path.
 *
 * Examples (given slug "guides/worker-threads"):
 *   "./debugging.mdx"       -> "/docs/guides/debugging"
 *   "./routing.md"          -> "/docs/guides/routing"
 *   "../architecture/how-it-works.md" -> "/docs/architecture/how-it-works"
 *
 * Non-.md/.mdx links and links without a slug are returned unchanged.
 */
export function resolveDocLink(href: string, slug?: string): string {
  if (!/\.mdx?$/.test(href) || !slug) return href;

  const section = slug.split("/")[0];
  const target = href.replace(/^\.\//, "").replace(/\.mdx?$/, "");

  if (target.startsWith("../")) {
    return `/docs/${target.replace(/^\.\.\//g, "")}`;
  }

  return `/docs/${section}/${target}`;
}
