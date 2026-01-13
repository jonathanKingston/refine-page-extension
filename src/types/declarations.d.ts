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

// Declaration for @recogito/text-annotator
declare module '@recogito/text-annotator' {
  export function createTextAnnotator(
    element: HTMLElement,
    options?: unknown
  ): {
    addAnnotation: (annotation: unknown) => void;
    removeAnnotation: (id: string) => void;
    updateAnnotation: (annotation: unknown) => void;
    getAnnotations: () => unknown[];
    setAnnotations: (annotations: unknown[]) => void;
    setAnnotatingEnabled: (enabled: boolean) => void;
    setAnnotatingMode: (mode: string) => void;
    on: (event: string, handler: (annotation: unknown) => void) => void;
    off: (event: string, handler: (annotation: unknown) => void) => void;
    destroy: () => void;
  };
}

// Declaration for webmarker-js
declare module 'webmarker-js' {
  export interface MarkedElement {
    element: HTMLElement;
    markElement: HTMLElement;
    boundingBoxElement?: HTMLElement;
    label: string;
  }

  export interface MarkOptions {
    containerElement: HTMLElement;
    selector?: string;
    showBoundingBoxes?: boolean;
    markStyle?: Record<string, string>;
    boundingBoxStyle?: Record<string, string>;
    markPlacement?: string;
  }

  export function mark(options: MarkOptions): Record<string, MarkedElement>;

  export function unmark(): void;

  export function isMarked(element: HTMLElement): boolean;
}
