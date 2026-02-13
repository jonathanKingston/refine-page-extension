/**
 * Tests for content/capture.ts - page metadata extraction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('content/capture', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getListeners(): Array<(...args: any[]) => any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).chrome.runtime.onMessage._listeners;
  }

  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
  });

  it('should register a message listener on import', async () => {
    await import('./capture');
    expect(getListeners().length).toBeGreaterThanOrEqual(1);
  });

  it('should respond to GET_PAGE_METADATA with page metadata', async () => {
    // Set up DOM state that getPageMetadata reads
    Object.defineProperty(window, 'location', {
      value: { href: 'https://example.com/page' },
      writable: true,
    });
    Object.defineProperty(document, 'title', {
      value: 'Test Page Title',
      writable: true,
    });
    Object.defineProperty(window, 'innerWidth', {
      value: 1920,
      writable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 1080,
      writable: true,
    });

    await import('./capture');

    const listener = getListeners()[getListeners().length - 1];
    const sendResponse = vi.fn();

    // The listener returns true for async response
    const result = listener({ type: 'GET_PAGE_METADATA' }, {}, sendResponse);

    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'PAGE_METADATA',
      payload: {
        url: 'https://example.com/page',
        title: 'Test Page Title',
        viewport: {
          width: 1920,
          height: 1080,
        },
      },
    });
  });

  it('should ignore non-GET_PAGE_METADATA messages', async () => {
    await import('./capture');

    const listener = getListeners()[getListeners().length - 1];
    const sendResponse = vi.fn();

    const result = listener({ type: 'OTHER_MESSAGE' }, {}, sendResponse);

    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
