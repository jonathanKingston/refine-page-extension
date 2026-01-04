/**
 * Type declarations for modules without TypeScript types
 */

declare module 'mhtml2html' {
  interface MhtmlParseResult {
    index: string;
    media: {
      [url: string]: {
        data: string;
        type: string;
        encoding: string;
      };
    };
  }

  interface ConvertOptions {
    parseDOM?: (html: string) => { window: Window };
    convertIframes?: boolean;
  }

  export function parse(mhtml: string, options?: { htmlOnly?: boolean }): MhtmlParseResult;

  export function convert(mhtml: string | MhtmlParseResult, options?: ConvertOptions): Document;

  const mhtml2html: {
    parse: typeof parse;
    convert: typeof convert;
  };
  export default mhtml2html;
}

// Declaration for CSS imports
declare module '*.css' {
  const content: string;
  export default content;
}
