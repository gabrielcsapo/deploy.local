import { useState, useRef, type ReactNode } from "react";

export function PreBlock({ children, language }: { children: ReactNode; language: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = () => {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative group my-4">
      {language && (
        <span className="absolute top-2 right-12 text-xs text-gray-400 font-mono select-none z-10">
          {language}
        </span>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 p-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-all"
        aria-label="Copy code"
      >
        {copied ? (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </button>
      <pre
        ref={preRef}
        className="bg-gray-900 dark:bg-gray-800 rounded-lg p-4 overflow-x-auto text-sm"
      >
        {children}
      </pre>
    </div>
  );
}
