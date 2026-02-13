/**
 * Chrome extension API mock for testing.
 * Provides a minimal but functional mock of chrome.* APIs used by the extension.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from 'vitest';

export function createMockChrome(): any {
  const storageData: Record<string, unknown> = {};

  const storage = {
    data: storageData,
    get: vi.fn(async (keys: string | string[]) => {
      if (typeof keys === 'string') {
        return { [keys]: storageData[keys] };
      }
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (key in storageData) {
          result[key] = storageData[key];
        }
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(storageData, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const keyList = typeof keys === 'string' ? [keys] : keys;
      for (const key of keyList) {
        delete storageData[key];
      }
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messageListeners: Array<(...args: any[]) => any> = [];

  const onMessage = {
    addListener: vi.fn((...args: any[]) => {
      onMessage._listeners.push(args[0]);
    }),
    removeListener: vi.fn((...args: any[]) => {
      const idx = onMessage._listeners.indexOf(args[0]);
      if (idx >= 0) onMessage._listeners.splice(idx, 1);
    }),
    _listeners: messageListeners,
  };

  return {
    runtime: {
      sendMessage: vi.fn((...args: any[]) => {
        // Support both callback and promise-based calling conventions
        const callback = args.find((a: unknown) => typeof a === 'function');
        if (callback) {
          // Callback style: chrome.runtime.sendMessage(msg, callback)
          return undefined;
        }
        // Promise style: chrome.runtime.sendMessage(msg)
        return Promise.resolve(undefined);
      }),
      onMessage,
      getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
      getContexts: vi.fn(async () => []),
      id: 'test-extension-id',
      lastError: null,
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      onInstalled: {
        addListener: vi.fn(),
      },
    },
    storage: {
      local: storage,
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 1 })),
      sendMessage: vi.fn(async () => ({})),
      get: vi.fn(async () => ({ id: 1, url: 'https://example.com', status: 'complete' })),
    },
    pageCapture: {
      saveAsMHTML: vi.fn(),
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      Reason: { DOM_PARSER: 'DOM_PARSER' },
    },
    scripting: {
      executeScript: vi.fn(async () => []),
    },
  };
}

/**
 * Install mock chrome globally. Call in beforeEach.
 */
export function installMockChrome(): MockChrome {
  const mock = createMockChrome();
  (globalThis as Record<string, unknown>).chrome = mock;
  return mock;
}

/**
 * Remove mock chrome from global. Call in afterEach.
 */
export function uninstallMockChrome(): void {
  delete (globalThis as Record<string, unknown>).chrome;
}
