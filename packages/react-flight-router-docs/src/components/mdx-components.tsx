import type { ReactNode } from "react";
import { PreBlock } from "./code-block";
import { PerfDashboardSample } from "./perf-dashboard-sample";
import { useRouter } from "../router";

function MdxLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { navigate } = useRouter();
  const resolvedHref = href ?? "";

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
}

function MdxPre({ children }: { children?: ReactNode }) {
  return <PreBlock language="">{children}</PreBlock>;
}

function MdxCode({ children, className }: { children?: ReactNode; className?: string }) {
  if (!className) {
    return <code className="hljs px-1.5 py-0.5 rounded text-sm font-mono !inline">{children}</code>;
  }
  return <code className={className}>{children}</code>;
}

/**
 * Shared component map used by both compiled MDX pages and the MarkdownRenderer.
 * Includes styled overrides for all standard markdown elements plus custom components.
 */
export const mdxComponents: Record<string, unknown> = {
  // Custom components available in MDX
  PerfDashboardSample,

  // Standard markdown element overrides
  a: MdxLink,
  pre: MdxPre,
  code: MdxCode,
  h1: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h1 id={id} className="text-3xl font-bold mt-8 mb-4 scroll-mt-20">
      {children}
    </h1>
  ),
  h2: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h2
      id={id}
      className="text-2xl font-bold mt-10 mb-4 scroll-mt-20 border-b border-gray-200 dark:border-gray-800 pb-2"
    >
      {children}
    </h2>
  ),
  h3: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h3 id={id} className="text-xl font-semibold mt-8 mb-3 scroll-mt-20">
      {children}
    </h3>
  ),
  h4: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h4 id={id} className="text-lg font-semibold mt-6 mb-2 scroll-mt-20">
      {children}
    </h4>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="my-4 leading-7 text-gray-700 dark:text-gray-300">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="my-4 pl-6 list-disc space-y-2 text-gray-700 dark:text-gray-300">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="my-4 pl-6 list-decimal space-y-2 text-gray-700 dark:text-gray-300">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="leading-7">{children}</li>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-4 border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950/50 pl-4 py-2 text-gray-700 dark:text-gray-300 rounded-r">
      {children}
    </blockquote>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border border-gray-200 dark:border-gray-700 px-4 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-gray-200 dark:border-gray-700 px-4 py-2">{children}</td>
  ),
  hr: () => <hr className="my-8 border-gray-200 dark:border-gray-800" />,
};
