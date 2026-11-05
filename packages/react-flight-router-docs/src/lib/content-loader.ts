import { parseFrontmatter, type Frontmatter } from "./frontmatter";
import type { ComponentType } from "react";

// Plain markdown — loaded as raw strings, rendered via react-markdown
const markdownModules = import.meta.glob<string>("/content/**/*.md", {
  query: "?raw",
  import: "default",
});

// MDX — compiled to React components by @mdx-js/rollup
const mdxModules = import.meta.glob<{
  default: ComponentType<{ components?: Record<string, unknown> }>;
  frontmatter: Record<string, string>;
}>("/content/**/*.mdx");

// MDX raw source — for TOC heading extraction and search
const mdxRawModules = import.meta.glob<string>("/content/**/*.mdx", {
  query: "?raw",
  import: "default",
});

export type MarkdownContent = {
  type: "markdown";
  frontmatter: Frontmatter;
  body: string;
};
export type MDXContent = {
  type: "mdx";
  frontmatter: Frontmatter;
  Component: ComponentType<{ components?: Record<string, unknown> }>;
  raw: () => {
    type: string;
  };
};
export type ContentResult = MarkdownContent | MDXContent;

export async function loadContent(slug: string): Promise<ContentResult | null> {
  // MDX takes priority over markdown
  const mdxKey = `/content/${slug}.mdx`;
  const mdxLoader = mdxModules[mdxKey];
  if (mdxLoader) {
    const mod = await mdxLoader();
    const rawLoader = mdxRawModules[mdxKey];
    const raw = rawLoader ? await rawLoader() : "";
    return {
      type: "mdx",
      frontmatter: {
        title: mod.frontmatter?.title ?? "",
        description: mod.frontmatter?.description ?? "",
      },
      Component: mod.default,
      raw,
    };
  }

  // Fall back to plain markdown
  const mdKey = `/content/${slug}.md`;
  const mdLoader = markdownModules[mdKey];
  if (!mdLoader) return null;

  const rawMd = await mdLoader();
  const result = parseFrontmatter(rawMd);
  return { type: "markdown", ...result };
}
