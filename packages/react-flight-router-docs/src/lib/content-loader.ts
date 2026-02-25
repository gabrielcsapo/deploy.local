import { parseFrontmatter, type Frontmatter } from "./frontmatter";

const markdownModules = import.meta.glob<string>("/content/**/*.md", {
  query: "?raw",
  import: "default",
});

export async function loadContent(
  slug: string,
): Promise<{ frontmatter: Frontmatter; body: string } | null> {
  const key = `/content/${slug}.md`;
  const loader = markdownModules[key];

  if (!loader) return null;

  const raw = await loader();
  return parseFrontmatter(raw);
}
