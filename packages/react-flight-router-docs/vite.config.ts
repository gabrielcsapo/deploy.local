import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../react-flight-router/package.json"), "utf-8"),
);

export default defineConfig({
  base: "/react-flight-router/",
  define: {
    __PACKAGE_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    tailwindcss(),
    mdx({
      include: /\.mdx$/,
      remarkPlugins: [
        remarkGfm,
        remarkFrontmatter,
        [remarkMdxFrontmatter, { name: "frontmatter" }],
      ],
      rehypePlugins: [rehypeHighlight, rehypeSlug],
    }),
    react(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
  },
});
