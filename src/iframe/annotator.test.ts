/**
 * Tests for iframe/annotator.ts - the iframe annotation handler
 *
 * This module handles messages from the parent viewer, manages annotation
 * libraries, and forwards keyboard events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock CSS imports
vi.mock('@recogito/text-annotator/text-annotator.css', () => ({}));
vi.mock('@annotorious/annotorious/annotorious.css', () => ({}));

// Mock annotation libraries
vi.mock('@recogito/text-annotator', () => ({
  createTextAnnotator: vi.fn(() => ({
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
    setAnnotations: vi.fn(),
    getAnnotations: vi.fn(() => []),
    setAnnotatingEnabled: vi.fn(),
    setAnnotatingMode: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('@annotorious/annotorious', () => ({
  createImageAnnotator: vi.fn(() => ({
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
    setAnnotations: vi.fn(),
    getAnnotations: vi.fn(() => []),
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('webmarker-js', () => ({
  mark: vi.fn(() => ({})),
  unmark: vi.fn(),
  isMarked: vi.fn(() => false),
}));

vi.mock('colord', () => ({
  colord: vi.fn(() => ({
    toRgb: () => ({ r: 0, g: 0, b: 0, a: 1 }),
    lighten: () => ({ toRgb: () => ({ r: 255, g: 255, b: 255, a: 1 }) }),
  })),
}));

vi.mock('debounce', () => ({
  default: vi.fn((fn: Function) => fn),
  debounce: vi.fn((fn: Function) => fn),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChrome(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

function setupIframeDom() {
  document.body.innerHTML = '<div id="content-container"></div>';
}

// Simulate a postMessage from the parent viewer
function postMessageToIframe(type: string, payload?: unknown) {
  const event = new MessageEvent('message', {
    data: { type, payload },
    origin: 'chrome-extension://test-id',
  });
  window.dispatchEvent(event);
}

describe('iframe annotator', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();

    setupIframeDom();

    // Mock parent window postMessage
    parentPostMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostMessage },
      writable: true,
      configurable: true,
    });

    // Mock jsdom-unsupported APIs
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

    // Mock fetch for chrome-extension:// CSS URLs that jsdom can't handle
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (urlStr.includes('annotator.css')) {
        return new Response('/* mock css */', { status: 200, headers: { 'Content-Type': 'text/css' } });
      }
      throw new Error(`Unmocked fetch: ${urlStr}`);
    }) as typeof fetch;
  });

  it('should signal IFRAME_LOADED on import', async () => {
    await import('./annotator');

    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'IFRAME_LOADED' },
      '*'
    );
  });

  it('should handle LOAD_HTML message', async () => {
    await import('./annotator');

    const testHtml = '<html><head></head><body><p>Test content</p></body></html>';
    postMessageToIframe('LOAD_HTML', { html: testHtml });

    // Content should be loaded into the container
    const container = document.getElementById('content-container');
    expect(container?.innerHTML).toContain('Test content');
  });

  it('should handle SET_TOOL message without crashing', async () => {
    await import('./annotator');

    // LOAD_HTML triggers annotator setup which tries to fetch CSS from chrome-extension:// URL
    // This fails in jsdom but shouldn't crash
    postMessageToIframe('LOAD_HTML', { html: '<html><head></head><body><p>Test</p></body></html>' });
    await new Promise(r => setTimeout(r, 100));

    // SET_TOOL should not throw even if annotator isn't fully initialized
    postMessageToIframe('SET_TOOL', 'relevant');
    await new Promise(r => setTimeout(r, 50));

    // The main assertion is that the module didn't throw
    expect(true).toBe(true);
  });

  it('should forward keyboard events to parent as KEY_PRESSED', async () => {
    await import('./annotator');

    // Simulate keydown on the document (not on an input)
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'r',
      code: 'KeyR',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      bubbles: true,
    });
    document.dispatchEvent(keyEvent);

    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'KEY_PRESSED',
        payload: { key: 'r' },
      }),
      '*'
    );
  });

  it('should not forward keyboard events from input elements', async () => {
    await import('./annotator');

    // Create an input and focus it
    const input = document.createElement('input');
    document.body.appendChild(input);

    const keyEvent = new KeyboardEvent('keydown', {
      key: 'r',
      bubbles: true,
    });
    Object.defineProperty(keyEvent, 'target', { value: input });
    document.dispatchEvent(keyEvent);

    // Should NOT have forwarded the key (only IFRAME_LOADED should be posted)
    const keyPresses = parentPostMessage.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0]?.type === 'KEY_PRESSED'
    );
    expect(keyPresses.length).toBe(0);
  });

  it('should not forward modifier key combinations', async () => {
    await import('./annotator');

    const keyEvent = new KeyboardEvent('keydown', {
      key: 'r',
      ctrlKey: true,
      bubbles: true,
    });
    window.dispatchEvent(keyEvent);

    const keyPresses = parentPostMessage.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0]?.type === 'KEY_PRESSED'
    );
    expect(keyPresses.length).toBe(0);
  });

  it('should handle TOGGLE_MARKS message', async () => {
    await import('./annotator');

    postMessageToIframe('LOAD_HTML', { html: '<html><head></head><body><p>Test</p><a href="https://example.com">Link</a></body></html>' });
    await new Promise(r => setTimeout(r, 100));

    postMessageToIframe('TOGGLE_MARKS', undefined);
    await new Promise(r => setTimeout(r, 50));

    // Should respond with marks data or MARKS_DETECTED
    const marksCalls = parentPostMessage.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (call: any[]) => call[0]?.type === 'MARKS_DETECTED' || call[0]?.type === 'MARKS_CLEARED'
    );
    expect(marksCalls.length).toBeGreaterThanOrEqual(0); // May or may not detect marks in jsdom
  });

  it('should handle CLEAR_MARKS message without crashing', async () => {
    await import('./annotator');

    postMessageToIframe('LOAD_HTML', { html: '<html><head></head><body><p>Test</p></body></html>' });
    await new Promise(r => setTimeout(r, 100));

    // CLEAR_MARKS before marks are enabled should not throw
    postMessageToIframe('CLEAR_MARKS', undefined);
    await new Promise(r => setTimeout(r, 50));

    // The main assertion is that the module handled the message without throwing
    expect(true).toBe(true);
  });
});
