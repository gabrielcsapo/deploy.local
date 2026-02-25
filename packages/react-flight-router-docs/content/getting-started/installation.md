---
title: "Installation"
description: "Install Flight Router and its dependencies to start building React Server Component applications with file-based routing."
---

# Installation

This guide walks you through installing Flight Router and its required dependencies.

## Prerequisites

Before you begin, make sure you have the following installed:

- **Node.js 20+** -- Flight Router requires Node.js version 20 or later. You can check your version with `node -v`.
- **A package manager** -- npm (included with Node.js), [pnpm](https://pnpm.io/), or [yarn](https://yarnpkg.com/).

## Install dependencies

Flight Router builds on React 19, React Server Components, Vite, and [Hono](https://hono.dev/) for the production server. Install the core dependencies:

```bash
npm install react react-dom react-server-dom-webpack flight-router hono @hono/node-server
```

Then install the required dev dependencies for building and running the development server:

```bash
npm install -D vite @vitejs/plugin-react typescript
```

If you use pnpm or yarn, substitute the appropriate command:

```bash
# pnpm
pnpm add react react-dom react-server-dom-webpack flight-router hono @hono/node-server
pnpm add -D vite @vitejs/plugin-react typescript

# yarn
yarn add react react-dom react-server-dom-webpack flight-router hono @hono/node-server
yarn add -D vite @vitejs/plugin-react typescript
```

## Optional: Tailwind CSS

Flight Router has built-in support for [Tailwind CSS v4](https://tailwindcss.com/). To add it to your project:

```bash
npm install -D tailwindcss @tailwindcss/vite
```

Then create a CSS file (for example, `app/styles.css`) and import Tailwind:

```css
@import "tailwindcss";
```

Import this file in your root layout component so that styles are available throughout your application. See [Vite Configuration](./vite-config.md) for how to add the Tailwind plugin to your Vite config.

## TypeScript configuration

Create a `tsconfig.json` in the root of your project:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["react/experimental", "react-dom/experimental"]
  },
  "include": ["app", "server.ts", "vite.config.ts"]
}
```

## Verify your setup

Your `package.json` should look similar to this:

```json
{
  "name": "my-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "flight-router build",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@hono/node-server": "^1.19.9",
    "flight-router": "^0.1.0",
    "hono": "^4.12.1",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "react-server-dom-webpack": "^19.2.4"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.5.2",
    "typescript": "^5.8.0",
    "vite": "^7.3.1"
  }
}
```

Note the `"type": "module"` field -- Flight Router uses ES modules throughout.

## Next steps

Now that you have everything installed, set up your [project structure](./project-structure.md) and [Vite configuration](./vite-config.md), then create [your first route](./first-route.md).
