---
title: "CSS & Styling"
description: "How to style your Flight Router application with Tailwind CSS, CSS modules, and global stylesheets."
---

# CSS & Styling

Flight Router supports several approaches to styling your application, including Tailwind CSS v4, CSS modules, and global CSS files. All styles work in both server and client components, and are automatically extracted and optimized in production builds.

## Tailwind CSS v4

Tailwind CSS v4 is the recommended styling approach. It integrates directly with Vite through the `@tailwindcss/vite` plugin.

### Installation

Install the required packages:

```bash
pnpm add tailwindcss @tailwindcss/vite
```

### Vite Configuration

Add the Tailwind plugin to your `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
});
```

### Create Your Stylesheet

Create a CSS file that imports Tailwind:

```css
/* app/styles.css */
@import "tailwindcss";
```

### Import in Your Root Layout

Import the stylesheet in your root layout so it applies globally:

```tsx
// app/root.tsx
import "./styles.css";

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>My App</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### Using Tailwind Classes

Use Tailwind utility classes in both server and client components:

```tsx
// Server component
export default function HomePage() {
  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-gray-900">Welcome</h1>
      <p className="mt-4 text-gray-600">This is a server component with Tailwind.</p>
    </div>
  );
}
```

```tsx
// Client component
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button
      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
      onClick={() => setCount(count + 1)}
    >
      Count: {count}
    </button>
  );
}
```

## Global CSS

Import any CSS file in a server component to make it globally available:

```css
/* app/global.css */
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  line-height: 1.6;
  color: #333;
}

a {
  color: #0070f3;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
```

```tsx
// app/root.tsx
import "./global.css";

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## CSS Modules

CSS modules scope styles to individual components, preventing class name collisions. Use the `.module.css` extension.

```css
/* app/routes/dashboard.module.css */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.title {
  font-size: 2rem;
  font-weight: 700;
  margin-bottom: 1rem;
}

.card {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  padding: 1.5rem;
}
```

Import the module and use the `styles` object to reference class names:

```tsx
// app/routes/dashboard.tsx
import styles from "./dashboard.module.css";

export default function Dashboard() {
  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Dashboard</h1>
      <div className={styles.card}>
        <p>Your dashboard content here.</p>
      </div>
    </div>
  );
}
```

CSS modules work in both server and client components.

## Combining Approaches

You can freely mix styling approaches within the same application. For example, use Tailwind for utility styles and CSS modules for complex component-specific styles:

```tsx
import styles from "./header.module.css";

export default function Header() {
  return (
    <header className={styles.header}>
      <nav className="flex items-center gap-4">
        <a href="/" className={styles.logo}>
          My App
        </a>
        <a href="/about" className="text-gray-600 hover:text-gray-900">
          About
        </a>
      </nav>
    </header>
  );
}
```

## Production Builds

In production, Flight Router's build pipeline automatically:

- Extracts CSS into separate optimized files
- Minifies and deduplicates styles
- Generates hashed filenames for cache busting
- Injects `<link rel="stylesheet">` tags into the server-rendered HTML

No additional configuration is required. Run `flight-router build` and all CSS is handled for you.
