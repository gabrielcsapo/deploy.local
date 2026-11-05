import { useState, useEffect } from "react";
import { loadContent, type ContentResult } from "../lib/content-loader";
import { MarkdownRenderer } from "../components/markdown-renderer";
import { mdxComponents, MdxSlugProvider } from "../components/mdx-components";
import { TableOfContents } from "../components/table-of-contents";
import { PrevNextNav } from "../components/prev-next-nav";

export function DocPage({ slug }: { slug: string }) {
  const [content, setContent] = useState<ContentResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    loadContent(slug).then((result) => {
      if (cancelled) return;
      setContent(result);
      setLoading(false);
      if (result?.frontmatter.title) {
        document.title = `${result.frontmatter.title} - React Flight Router`;
      }
      // Scroll to hash anchor after content renders (e.g. from search result links)
      const hash = window.location.hash;
      if (hash) {
        requestAnimationFrame(() => {
          const el = document.getElementById(hash.slice(1));
          if (el) el.scrollIntoView({ behavior: "smooth" });
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!content) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-2xl font-bold mb-4">Page Not Found</h1>
        <p className="text-gray-600 dark:text-gray-400">
          The documentation page "{slug}" could not be found.
        </p>
      </div>
    );
  }

  // Raw text for TableOfContents heading extraction
  const tocSource = content.type === "mdx" ? content.raw().type : content.body;

  return (
    <div className="flex gap-8">
      <article className="min-w-0 flex-1 pb-16">
        {content.type === "mdx" ? (
          <MdxSlugProvider slug={slug}>
            <div className="prose-wrapper">
              <content.Component components={mdxComponents} />
            </div>
          </MdxSlugProvider>
        ) : (
          <MarkdownRenderer content={content.body} slug={slug} />
        )}
        <PrevNextNav currentSlug={slug} />
      </article>
      <aside className="hidden xl:block w-56 shrink-0">
        <TableOfContents content={tocSource} />
      </aside>
    </div>
  );
}
