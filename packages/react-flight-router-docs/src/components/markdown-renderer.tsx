import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import { PreBlock } from "./code-block";
import { useRouter } from "../router";
import { resolveDocLink } from "../lib/resolve-doc-link";
import type { Components } from "react-markdown";

import "highlight.js/styles/github-dark.min.css";

export function MarkdownRenderer({ content, slug }: { content: string; slug?: string }) {
  const { navigate } = useRouter();

  const components: Components = {
    pre({ children, node }) {
      // Extract language from the code child's className
      const codeNode = node?.children?.[0];
      const classNames =
        codeNode?.type === "element"
          ? (codeNode.properties?.className as string[] | undefined)
          : undefined;
      const langClass = classNames?.find((c) => typeof c === "string" && c.startsWith("language-"));
      const language = langClass?.replace("language-", "") ?? "";

      return <PreBlock language={language}>{children}</PreBlock>;
    },
    code({ children, className }) {
      // Block code (inside <pre>) has a className like "hljs language-ts"
      // Inline code has no className
      if (!className) {
        return (
          <code className="hljs px-1.5 py-0.5 rounded text-sm font-mono !inline">{children}</code>
        );
      }
      // Block code — keep hljs className intact for syntax highlighting
      return <code className={className}>{children}</code>;
    },
    a({ href, children }) {
      let resolvedHref = href ?? "";

      // Resolve relative .md/.mdx links (e.g., ./vite-config.md, ./debugging.mdx) to doc paths
      resolvedHref = resolveDocLink(resolvedHref, slug);

      if (resolvedHref.startsWith("/")) {
        return (
          <a
            href={resolvedHref}
            onClick={(e) => {
              e.preventDefault();
              navigate(resolvedHref);
            }}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={resolvedHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          {children}
        </a>
      );
    },
    h1({ children, id }) {
      return (
        <h1 id={id} className="text-3xl font-bold mt-8 mb-4 scroll-mt-20">
          {children}
        </h1>
      );
    },
    h2({ children, id }) {
      return (
        <h2
          id={id}
          className="text-2xl font-bold mt-10 mb-4 scroll-mt-20 border-b border-gray-200 dark:border-gray-800 pb-2"
        >
          {children}
        </h2>
      );
    },
    h3({ children, id }) {
      return (
        <h3 id={id} className="text-xl font-semibold mt-8 mb-3 scroll-mt-20">
          {children}
        </h3>
      );
    },
    h4({ children, id }) {
      return (
        <h4 id={id} className="text-lg font-semibold mt-6 mb-2 scroll-mt-20">
          {children}
        </h4>
      );
    },
    p({ children }) {
      return <p className="my-4 leading-7 text-gray-700 dark:text-gray-300">{children}</p>;
    },
    ul({ children }) {
      return (
        <ul className="my-4 pl-6 list-disc space-y-2 text-gray-700 dark:text-gray-300">
          {children}
        </ul>
      );
    },
    ol({ children }) {
      return (
        <ol className="my-4 pl-6 list-decimal space-y-2 text-gray-700 dark:text-gray-300">
          {children}
        </ol>
      );
    },
    li({ children }) {
      return <li className="leading-7">{children}</li>;
    },
    blockquote({ children }) {
      return (
        <blockquote className="my-4 border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950/50 pl-4 py-2 text-gray-700 dark:text-gray-300 rounded-r">
          {children}
        </blockquote>
      );
    },
    table({ children }) {
      return (
        <div className="my-4 overflow-x-auto">
          <table className="w-full text-sm border-collapse">{children}</table>
        </div>
      );
    },
    thead({ children }) {
      return <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>;
    },
    th({ children }) {
      return (
        <th className="border border-gray-200 dark:border-gray-700 px-4 py-2 text-left font-semibold">
          {children}
        </th>
      );
    },
    td({ children }) {
      return <td className="border border-gray-200 dark:border-gray-700 px-4 py-2">{children}</td>;
    },
    hr() {
      return <hr className="my-8 border-gray-200 dark:border-gray-800" />;
    },
  };

  // Strip HTML comments (e.g. <!-- BUILD_OUTPUT_START -->) that are used as
  // markers by scripts but should not be visible in rendered docs.
  const cleaned = content.replace(/<!--[\s\S]*?-->/g, "");

  return (
    <div className="prose-wrapper">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeSlug]}
        components={components}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}
