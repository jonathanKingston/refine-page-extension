/**
 * Tests for snapshot/snapshot.ts - snapshot viewer page
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChrome(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

function setupSnapshotDom() {
  document.body.innerHTML = `
    <div id="snapshot-title"></div>
    <div id="snapshot-url"></div>
    <div class="snapshot-frame-container">
      <iframe id="snapshot-frame"></iframe>
    </div>
    <button id="download-btn">Download</button>
    <button id="open-labeller">Open Labeller</button>
  `;
}

describe('snapshot viewer', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    setupSnapshotDom();
  });

  it('should show error when no snapshot ID provided', async () => {
    // Default location has no query params
    Object.defineProperty(window, 'location', {
      value: { search: '', href: 'http://localhost/' },
      writable: true,
    });

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const container = document.querySelector('.snapshot-frame-container');
    expect(container?.innerHTML).toContain('No snapshot ID provided');
  });

  it('should load and display a snapshot', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    const testSnapshot = {
      id: 'snap_1',
      url: 'https://example.com',
      title: 'Test Page',
      html: '<html><body>Hello World</body></html>',
      viewport: { width: 1920, height: 1080 },
      annotations: { text: [], region: [] },
      questions: [],
      status: 'pending',
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
    };

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_SNAPSHOT') {
          callback(testSnapshot);
        } else {
          callback({ success: true });
        }
      }
    );
    getChrome().runtime.lastError = null;

    // Mock URL.createObjectURL for blob URL
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-snapshot-url');

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Wait for async load
    await vi.waitFor(() => {
      const titleEl = document.getElementById('snapshot-title');
      expect(titleEl?.textContent).toBe('Test Page');
    });

    const urlEl = document.getElementById('snapshot-url');
    expect(urlEl?.textContent).toBe('https://example.com');
    expect(document.title).toContain('Test Page');
  });

  it('should show error when snapshot not found', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=nonexistent', href: 'http://localhost/?id=nonexistent' },
      writable: true,
    });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        callback(null);
      }
    );
    getChrome().runtime.lastError = null;

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      const container = document.querySelector('.snapshot-frame-container');
      expect(container?.innerHTML).toContain('Snapshot not found');
    });
  });

  it('should show error when sendMessage fails', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        getChrome().runtime.lastError = { message: 'Extension context invalidated' };
        callback(undefined);
        getChrome().runtime.lastError = null;
      }
    );

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      const container = document.querySelector('.snapshot-frame-container');
      expect(container?.innerHTML).toContain('Extension context invalidated');
    });
  });

  it('should handle download button click', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    const testSnapshot = {
      id: 'snap_1',
      url: 'https://example.com',
      title: 'Test <Page>',
      html: '<html><body>content</body></html>',
      viewport: { width: 1920, height: 1080 },
      annotations: { text: [], region: [] },
      questions: [],
      status: 'pending',
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
    };

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        callback(msg.type === 'GET_SNAPSHOT' ? testSnapshot : { success: true });
      }
    );
    getChrome().runtime.lastError = null;

    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('snapshot-title')?.textContent).toBe('Test <Page>');
    });

    // Click download
    const downloadBtn = document.getElementById('download-btn');
    downloadBtn?.click();

    // Should have created and revoked a blob URL
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('should handle open labeller button click', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    const testSnapshot = {
      id: 'snap_1', url: 'https://example.com', title: 'Test',
      html: '<html></html>', viewport: { width: 800, height: 600 },
      annotations: { text: [], region: [] }, questions: [],
      status: 'pending', capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tags: [],
    };

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        callback(msg.type === 'GET_SNAPSHOT' ? testSnapshot : { success: true });
      }
    );
    getChrome().runtime.lastError = null;
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('snapshot-title')?.textContent).toBe('Test');
    });

    const labellerBtn = document.getElementById('open-labeller');
    labellerBtn?.click();

    expect(getChrome().tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('snap_1') })
    );
  });

  it('should handle response error', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        callback({ error: 'Something went wrong' });
      }
    );
    getChrome().runtime.lastError = null;

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      const container = document.querySelector('.snapshot-frame-container');
      expect(container?.innerHTML).toContain('Something went wrong');
    });
  });

  it('should handle untitled snapshot', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/?id=snap_1' },
      writable: true,
    });

    const testSnapshot = {
      id: 'snap_1', url: 'https://example.com', title: '',
      html: '<html></html>', viewport: { width: 800, height: 600 },
      annotations: { text: [], region: [] }, questions: [],
      status: 'pending', capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), tags: [],
    };

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        callback(msg.type === 'GET_SNAPSHOT' ? testSnapshot : { success: true });
      }
    );
    getChrome().runtime.lastError = null;
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');

    await import('./snapshot');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('snapshot-title')?.textContent).toBe('Untitled');
    });
    expect(document.title).toContain('Snapshot');
  });
});
