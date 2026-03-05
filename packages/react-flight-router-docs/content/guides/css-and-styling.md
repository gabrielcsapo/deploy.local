---
title: "CSS & Styling"
description: "How to style your React Flight Router application with global CSS, CSS modules, and Vite-compatible tools like Tailwind."
---

# CSS & Styling

React Flight Router supports CSS imports in both server and client components. Any CSS approach that works with Vite works with React Flight Router — global stylesheets, CSS modules, Tailwind, and more. Styles are automatically extracted and optimized in production builds.

## Global CSS

Import any CSS file in a server component to make it globally available:

```css
/* app/styles.css */
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
import { Outlet } from "react-flight-router/client";
import "./styles.css";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <Outlet />
      </body>
    </html>
  );
}
```

CSS imported in server components is picked up by the build pipeline and included in the client bundle automatically.

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

## Using Tailwind CSS

Since React Flight Router uses Vite, you can add Tailwind CSS (or any other Vite plugin-based CSS tool) through your Vite config.

### Installation

```bash
pnpm add tailwindcss @tailwindcss/vite
```

### Vite Configuration

Add the Tailwind plugin to your `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { flightRouter } from "react-flight-router/dev";

export default defineConfig({
  plugins: [tailwindcss(), react(), flightRouter()],
});
```

The Tailwind plugin should come **before** the other plugins. See [Vite Configuration](../getting-started/vite-config.md) for more details on plugin ordering.

### Create Your Stylesheet

```css
/* app/styles.css */
@import "tailwindcss";
```

Import it in your root layout and use Tailwind classes anywhere:

```tsx
export default function HomePage() {
  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-3xl font-bold text-gray-900">Welcome</h1>
      <p className="mt-4 text-gray-600">Tailwind classes work in server and client components.</p>
    </div>
  );
}
```

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

In production, the build pipeline automatically:

- Extracts CSS into separate optimized files
- Minifies and deduplicates styles
- Generates hashed filenames for cache busting
- Injects `<link rel="stylesheet">` tags into the server-rendered HTML

No additional configuration is required. Run `react-flight-router build` and all CSS is handled for you.

## See also

- [Vite Configuration](../getting-started/vite-config.md) — Tailwind CSS plugin setup
- [Project Structure](../getting-started/project-structure.md) — where to place stylesheets
