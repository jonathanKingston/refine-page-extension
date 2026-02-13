/**
 * Tests for background/background.ts - service worker message handlers and storage
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Snapshot } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChrome(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

function getMessageListeners() {
  return getChrome().runtime.onMessage._listeners;
}

function getLastMessageListener() {
  const l = getMessageListeners();
  return l[l.length - 1];
}

function getInstallListeners() {
  return getChrome().runtime.onInstalled.addListener.mock.calls.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (call: any[]) => call[0]
  );
}

/** Helper: send a message to the background listener and wait for async response */
async function sendMessage(type: string, payload?: unknown, sender?: unknown): Promise<unknown> {
  const listener = getLastMessageListener();
  return new Promise((resolve) => {
    listener({ type, payload }, sender || {}, resolve);
  });
}

function makeTestSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap_1',
    url: 'https://example.com',
    title: 'Test Page',
    html: '<html><body>test</body></html>',
    viewport: { width: 1920, height: 1080 },
    annotations: { text: [], region: [] },
    questions: [],
    status: 'pending',
    capturedAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('background service worker', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should register message and install listeners', () => {
    expect(getMessageListeners().length).toBeGreaterThanOrEqual(1);
    expect(getChrome().runtime.onInstalled.addListener).toHaveBeenCalled();
  });

  it('should initialize storage on install', () => {
    const installListeners = getInstallListeners();
    const listener = installListeners[installListeners.length - 1];
    listener({ reason: 'install' });
    expect(getChrome().storage.local.set).toHaveBeenCalledWith({ snapshotIndex: [] });
  });

  it('should not initialize storage on update', () => {
    const installListeners = getInstallListeners();
    const listener = installListeners[installListeners.length - 1];
    getChrome().storage.local.set.mockClear();
    listener({ reason: 'update' });
    expect(getChrome().storage.local.set).not.toHaveBeenCalled();
  });
});

describe('message handler - CRUD operations', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should save and retrieve a snapshot', async () => {
    const snapshot = makeTestSnapshot();

    const saveResult = await sendMessage('SAVE_SNAPSHOT', { snapshot });
    expect(saveResult).toEqual({ success: true });

    const retrieved = await sendMessage('GET_SNAPSHOT', { id: 'snap_1' });
    expect(retrieved).toMatchObject({ id: 'snap_1', title: 'Test Page' });
  });

  it('should return undefined for non-existent snapshot', async () => {
    const retrieved = await sendMessage('GET_SNAPSHOT', { id: 'nonexistent' });
    expect(retrieved).toBeUndefined();
  });

  it('should list all snapshot summaries', async () => {
    const snap1 = makeTestSnapshot({ id: 'snap_1', title: 'Page 1' });
    const snap2 = makeTestSnapshot({ id: 'snap_2', title: 'Page 2' });
    await sendMessage('SAVE_SNAPSHOT', { snapshot: snap1 });
    await sendMessage('SAVE_SNAPSHOT', { snapshot: snap2 });

    const summaries = (await sendMessage('GET_ALL_SNAPSHOTS')) as Array<{
      id: string;
      title: string;
      annotationCount: { text: number; region: number };
    }>;
    expect(summaries).toHaveLength(2);
    // Summaries should not include html
    expect(summaries[0]).toHaveProperty('annotationCount');
    expect(summaries[0]).not.toHaveProperty('html');
  });

  it('should update a snapshot', async () => {
    const snapshot = makeTestSnapshot();
    await sendMessage('SAVE_SNAPSHOT', { snapshot });

    const updated = (await sendMessage('UPDATE_SNAPSHOT', {
      id: 'snap_1',
      updates: { title: 'Updated Title', status: 'approved' },
    })) as Snapshot;

    expect(updated.title).toBe('Updated Title');
    expect(updated.status).toBe('approved');
    expect(updated.updatedAt).not.toBe('2024-01-01T00:00:00Z');
  });

  it('should return undefined when updating non-existent snapshot', async () => {
    const result = await sendMessage('UPDATE_SNAPSHOT', {
      id: 'nonexistent',
      updates: { title: 'Updated' },
    });
    expect(result).toBeUndefined();
  });

  it('should delete a snapshot', async () => {
    const snapshot = makeTestSnapshot();
    await sendMessage('SAVE_SNAPSHOT', { snapshot });

    const result = await sendMessage('DELETE_SNAPSHOT', { id: 'snap_1' });
    expect(result).toEqual({ success: true });

    const retrieved = await sendMessage('GET_SNAPSHOT', { id: 'snap_1' });
    expect(retrieved).toBeUndefined();
  });

  it('should not duplicate snapshot index entries', async () => {
    const snapshot = makeTestSnapshot();
    await sendMessage('SAVE_SNAPSHOT', { snapshot });
    await sendMessage('SAVE_SNAPSHOT', { snapshot }); // Save again

    const storageData = getChrome().storage.local.data;
    expect(storageData.snapshotIndex).toEqual(['snap_1']);
  });
});

describe('message handler - export/import', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should export all data', async () => {
    const snap = makeTestSnapshot();
    await sendMessage('SAVE_SNAPSHOT', { snapshot: snap });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exported = (await sendMessage('EXPORT_DATA')) as any;
    expect(exported.version).toBe('1.0.0');
    expect(exported.snapshots).toHaveLength(1);
    expect(exported.snapshots[0].viewerUrl).toContain('snap_1');
    expect(exported.extensionId).toBe('test-extension-id');
  });

  it('should import data', async () => {
    const data = {
      version: '1.0.0',
      exportedAt: '2024-01-01T00:00:00Z',
      snapshots: [makeTestSnapshot({ id: 'import_1' }), makeTestSnapshot({ id: 'import_2' })],
    };

    const result = (await sendMessage('IMPORT_DATA', { data })) as {
      imported: number;
      skipped: number;
    };
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it('should skip existing snapshots on import', async () => {
    await sendMessage('SAVE_SNAPSHOT', { snapshot: makeTestSnapshot({ id: 'existing' }) });

    const data = {
      version: '1.0.0',
      exportedAt: '2024-01-01T00:00:00Z',
      snapshots: [makeTestSnapshot({ id: 'existing' }), makeTestSnapshot({ id: 'new_one' })],
    };

    const result = (await sendMessage('IMPORT_DATA', { data })) as {
      imported: number;
      skipped: number;
    };
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe('message handler - viewer and filtering', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should open viewer for a snapshot', async () => {
    const result = await sendMessage('OPEN_VIEWER', { snapshotId: 'snap_1' });
    expect(result).toEqual({ success: true });
    expect(getChrome().tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('snap_1') })
    );
  });

  it('should return false for unknown message types', () => {
    const listener = getLastMessageListener();
    const sendResponse = vi.fn();
    const result = listener({ type: 'UNKNOWN_TYPE' }, {}, sendResponse);
    expect(result).toBe(false);
  });

  it('should return false for messages without type', () => {
    const listener = getLastMessageListener();
    const sendResponse = vi.fn();
    const result = listener({}, {}, sendResponse);
    expect(result).toBe(false);
  });

  it('should return false for offscreen document response messages', () => {
    const listener = getLastMessageListener();
    const sendResponse = vi.fn();

    expect(listener({ type: 'CONVERT_MHTML_COMPLETE' }, {}, sendResponse)).toBe(false);
    expect(listener({ type: 'CONVERT_MHTML_ERROR' }, {}, sendResponse)).toBe(false);
  });
});

describe('message handler - CAPTURE_PAGE', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should return error when no active tab', async () => {
    getChrome().tabs.query.mockResolvedValue([]);

    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('No active tab') })
    );
  });

  it('should return error for chrome:// URLs', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 1, url: 'chrome://settings' }]);

    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('Cannot capture') })
    );
  });

  it('should return error for chrome-extension:// URLs', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 1, url: 'chrome-extension://abc/page.html' }]);

    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('Cannot capture') })
    );
  });

  it('should return error for edge:// URLs', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 1, url: 'edge://settings' }]);
    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('Cannot capture') })
    );
  });

  it('should return error for about: URLs', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 1, url: 'about:blank' }]);
    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('Cannot capture') })
    );
  });

  it('should return error for devtools:// URLs', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 1, url: 'devtools://abc' }]);
    const result = await sendMessage('CAPTURE_PAGE');
    expect(result).toEqual(
      expect.objectContaining({ error: expect.stringContaining('Cannot capture') })
    );
  });

  it('should capture page and create snapshot', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: {
        url: 'https://example.com',
        title: 'Example',
        viewport: { width: 1920, height: 1080 },
      },
    });

    // Mock MHTML capture
    const mhtmlBlob = { text: async () => 'fake-mhtml', size: 10 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);

    // Mock offscreen conversion response
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_COMPLETE',
      payload: { html: '<html>converted</html>', title: 'Example' },
    });

    // Mock hasOffscreenDocument
    getChrome().runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);

    const result = (await sendMessage('CAPTURE_PAGE')) as {
      type: string;
      payload: { snapshotId: string };
    };

    expect(result.type).toBe('CAPTURE_COMPLETE');
    expect(result.payload.snapshotId).toBeDefined();
  });

  it('should inject content script when sendMessage fails', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);

    // First sendMessage fails (content script not loaded)
    let callCount = 0;
    getChrome().tabs.sendMessage.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Could not establish connection');
      }
      return {
        payload: {
          url: 'https://example.com',
          title: 'Example',
          viewport: { width: 1920, height: 1080 },
        },
      };
    });

    getChrome().scripting.executeScript.mockResolvedValue([]);

    const mhtmlBlob = { text: async () => 'fake-mhtml', size: 10 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_COMPLETE',
      payload: { html: '<html>converted</html>', title: 'Example' },
    });
    getChrome().runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);

    const result = (await sendMessage('CAPTURE_PAGE')) as { type: string };
    expect(result.type).toBe('CAPTURE_COMPLETE');
    expect(getChrome().scripting.executeScript).toHaveBeenCalled();
  });

  it('should handle capture errors gracefully', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: {
        url: 'https://example.com',
        title: 'Example',
        viewport: { width: 1920, height: 1080 },
      },
    });

    // pageCapture fails
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(null);

    const result = (await sendMessage('CAPTURE_PAGE')) as {
      type: string;
      payload: { error: string };
    };
    expect(result.type).toBe('CAPTURE_ERROR');
    expect(result.payload.error).toBeDefined();
  });
});

describe('offscreen document management', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should create offscreen document when not present', async () => {
    getChrome().runtime.getContexts.mockResolvedValue([]);
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: { url: 'https://example.com', title: 'Test', viewport: { width: 800, height: 600 } },
    });
    const mhtmlBlob = { text: async () => 'mhtml', size: 5 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_COMPLETE',
      payload: { html: '<html></html>', title: 'Test' },
    });

    await sendMessage('CAPTURE_PAGE');
    expect(getChrome().offscreen.createDocument).toHaveBeenCalled();
  });

  it('should handle concurrent offscreen document creation (race guard)', async () => {
    // Make createDocument take time to simulate race condition
    let resolveCreate: () => void;
    getChrome().offscreen.createDocument.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCreate = resolve;
      })
    );
    getChrome().runtime.getContexts.mockResolvedValue([]);
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: { url: 'https://example.com', title: 'Test', viewport: { width: 800, height: 600 } },
    });
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue({ text: async () => 'mhtml', size: 5 });
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_COMPLETE',
      payload: { html: '<html></html>', title: 'Test' },
    });

    // Start two captures simultaneously — both will try to create offscreen doc
    const p1 = sendMessage('CAPTURE_PAGE');
    const p2 = sendMessage('CAPTURE_PAGE');

    // Resolve the pending creation
    resolveCreate!();

    await Promise.all([p1, p2]);

    // Should only have tried to create once (second call waits on first)
    expect(getChrome().offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('should not create offscreen document when already present', async () => {
    getChrome().runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: { url: 'https://example.com', title: 'Test', viewport: { width: 800, height: 600 } },
    });
    const mhtmlBlob = { text: async () => 'mhtml', size: 5 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_COMPLETE',
      payload: { html: '<html></html>', title: 'Test' },
    });

    await sendMessage('CAPTURE_PAGE');
    expect(getChrome().offscreen.createDocument).not.toHaveBeenCalled();
  });
});

describe('MHTML conversion error handling', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    await import('./background');
  });

  it('should handle offscreen conversion errors', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: { url: 'https://example.com', title: 'Test', viewport: { width: 800, height: 600 } },
    });
    const mhtmlBlob = { text: async () => 'mhtml', size: 5 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);
    getChrome().runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);

    // Offscreen returns error
    getChrome().runtime.sendMessage.mockResolvedValue({
      type: 'CONVERT_MHTML_ERROR',
      payload: { error: 'Conversion failed' },
    });

    const result = (await sendMessage('CAPTURE_PAGE')) as {
      type: string;
      payload: { error: string };
    };
    expect(result.type).toBe('CAPTURE_ERROR');
    expect(result.payload.error).toContain('Conversion failed');
  });

  it('should handle no response from offscreen document', async () => {
    getChrome().tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com' }]);
    getChrome().tabs.sendMessage.mockResolvedValue({
      payload: { url: 'https://example.com', title: 'Test', viewport: { width: 800, height: 600 } },
    });
    const mhtmlBlob = { text: async () => 'mhtml', size: 5 };
    getChrome().pageCapture.saveAsMHTML.mockResolvedValue(mhtmlBlob);
    getChrome().runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);

    // No response from offscreen
    getChrome().runtime.sendMessage.mockResolvedValue(null);

    const result = (await sendMessage('CAPTURE_PAGE')) as {
      type: string;
      payload: { error: string };
    };
    expect(result.type).toBe('CAPTURE_ERROR');
    expect(result.payload.error).toContain('No response from offscreen');
  });
});
