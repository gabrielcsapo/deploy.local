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
  return (
    md
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
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
      // Strip JSX self-closing tags (e.g., <PerfDashboardSample />)
      .replace(/<[A-Z]\w*\s*\/>/g, "")
      // Strip JSX comments ({/* ... */})
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\n{2,}/g, "\n")
      .trim()
  );
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

// Matches github-slugger (used by rehype-slug) behavior
function slugify(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .toLowerCase()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s/g, "-");
}

interface MdSection {
  heading: string;
  slug: string;
  content: string;
}

function extractSections(md: string): MdSection[] {
  const sections: MdSection[] = [];
  const headingRegex = /^#{2,3}\s+(.+)$/gm;
  let lastHeading: { text: string; slug: string; index: number } | null = null;
  let match;

  while ((match = headingRegex.exec(md)) !== null) {
    if (lastHeading) {
      sections.push({
        heading: lastHeading.text,
        slug: lastHeading.slug,
        content: stripMarkdown(
          md.slice(lastHeading.index + md.slice(lastHeading.index).indexOf("\n"), match.index),
        ).slice(0, 1000),
      });
    }
    lastHeading = {
      text: match[1].trim(),
      slug: slugify(match[1].trim()),
      index: match.index,
    };
  }

  // Last section
  if (lastHeading) {
    sections.push({
      heading: lastHeading.text,
      slug: lastHeading.slug,
      content: stripMarkdown(
        md.slice(lastHeading.index + md.slice(lastHeading.index).indexOf("\n")),
      ).slice(0, 1000),
    });
  }

  return sections;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
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
  const relPath = relative(contentDir, file)
    .replace(/\.mdx?$/, "")
    .replace(/\\/g, "/");
  const sectionKey = relPath.split("/")[0];
  const pageTitle = (data.title as string) || relPath.split("/").pop() || "";
  const sectionName = sectionNames[sectionKey] || sectionKey;

  // Page-level entry (covers title + intro content before first heading)
  entries.push({
    title: pageTitle,
    slug: relPath,
    path: `/docs/${relPath}`,
    section: sectionName,
    headings: extractHeadings(content),
    content: stripMarkdown(content).slice(0, 2000),
  });

  // Per-section entries — each heading gets its own searchable entry with #anchor path
  const sections = extractSections(content);
  for (const sec of sections) {
    entries.push({
      title: sec.heading,
      slug: `${relPath}#${sec.slug}`,
      path: `/docs/${relPath}#${sec.slug}`,
      section: `${sectionName} · ${pageTitle}`,
      headings: [],
      content: sec.content,
    });
  }
}

mkdirSync(publicDir, { recursive: true });
writeFileSync(resolve(publicDir, "search-index.json"), JSON.stringify(entries, null, 2));

console.log(`Search index built with ${entries.length} entries`);
