/**
 * Type declarations for modules without TypeScript types
 */

declare module 'single-file-core/single-file.js' {
  export function init(options: {
    fetch: (url: string, options?: RequestInit) => Promise<Response>;
    frameFetch?: (url: string, options?: RequestInit) => Promise<Response>;
  }): void;

  export function getPageData(
    options: Record<string, unknown>,
    initOptions: {
      fetch: (url: string, options?: RequestInit) => Promise<Response>;
      frameFetch?: (url: string, options?: RequestInit) => Promise<Response>;
    },
    doc: Document,
    win: Window
  ): Promise<{ content: string; title?: string; doctype?: string }>;
}

// Declaration for CSS imports
declare module '*.css' {
  const content: string;
  export default content;
}
