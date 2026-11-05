import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);

export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => {
    try {
      return hljs.highlight(code, { language }).value;
    } catch {
      return code;
    }
  }, [code, language]);

  return (
    <pre className="bg-gray-900 dark:bg-gray-800 rounded-lg p-4 overflow-x-auto text-sm my-4">
      <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
