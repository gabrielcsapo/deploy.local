export interface Frontmatter {
  title: string;
  description: string;
}

export function parseFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: { title: "", description: "" }, body: raw };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line
      .slice(colonIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }

  return {
    frontmatter: {
      title: meta.title ?? "",
      description: meta.description ?? "",
    },
    body: match[2],
  };
}
