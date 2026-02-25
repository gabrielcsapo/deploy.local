import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import matter from "gray-matter";

interface SearchEntry {
  title: string;
  slug: string;
  path: string;
  section: string;
  headings: string[];
  content: string;
}

const contentDir = resolve(import.meta.dirname, "../content");
const publicDir = resolve(import.meta.dirname, "../public");

const sectionNames: Record<string, string> = {
  "getting-started": "Getting Started",
  guides: "Guides",
  "api-reference": "API Reference",
  architecture: "Architecture",
};

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, (match) => {
      const text = match.match(/\[([^\]]*)\]/);
      return text ? text[1] : "";
    })
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~]+/g, "")
    .replace(/>\s+/g, "")
    .replace(/\|[^|\n]*\|/g, "")
    .replace(/-{3,}/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractHeadings(md: string): string[] {
  const headings: string[] = [];
  const regex = /^#{2,3}\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(md)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = walk(contentDir);
const entries: SearchEntry[] = [];

for (const file of files) {
  const raw = readFileSync(file, "utf-8");
  const { data, content } = matter(raw);
  const relPath = relative(contentDir, file).replace(/\.md$/, "").replace(/\\/g, "/");
  const sectionKey = relPath.split("/")[0];

  entries.push({
    title: (data.title as string) || relPath.split("/").pop() || "",
    slug: relPath,
    path: `/docs/${relPath}`,
    section: sectionNames[sectionKey] || sectionKey,
    headings: extractHeadings(content),
    content: stripMarkdown(content).slice(0, 2000),
  });
}

mkdirSync(publicDir, { recursive: true });
writeFileSync(resolve(publicDir, "search-index.json"), JSON.stringify(entries, null, 2));

console.log(`Search index built with ${entries.length} entries`);
