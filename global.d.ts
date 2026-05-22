declare const __APP_VERSION__: string;

// Allow side-effect CSS imports (Vite/Tailwind/xterm).
declare module '*.css';

// Vite ?raw: file contents as a string at build time.
declare module '*?raw' {
  const content: string;
  export default content;
}
