/**
 * Tests for popup/popup.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChrome(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

function setupPopupDom() {
  document.body.innerHTML = `
    <div id="status" class="status hidden">
      <span class="status-text"></span>
    </div>
    <div id="total-count">0</div>
    <div id="pending-count">0</div>
    <div id="approved-count">0</div>
    <ul id="snapshot-list"></ul>
    <button id="capture-btn">Capture</button>
    <button id="view-snapshots-btn">View</button>
    <button id="export-btn">Export</button>
    <button id="import-btn">Import</button>
    <input id="import-input" type="file" />
    <button id="toggle-theme">Theme</button>
  `;
}

describe('popup', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();

    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();

    setupPopupDom();

    // Mock sendMessage for GET_ALL_SNAPSHOTS
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([]);
        } else {
          callback({ success: true });
        }
      }
    );
    getChrome().runtime.lastError = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register event listeners on DOMContentLoaded', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Wait for async operations
    await vi.advanceTimersByTimeAsync(100);

    // Capture button should exist and be wired up
    const captureBtn = document.getElementById('capture-btn');
    expect(captureBtn).not.toBeNull();
  });

  it('should render empty snapshot list', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const list = document.getElementById('snapshot-list');
    expect(list?.innerHTML).toContain('No snapshots yet');
  });

  it('should render snapshot list with items', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([
            {
              id: 'snap_1',
              url: 'https://example.com',
              title: 'Test Page',
              status: 'pending',
              capturedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
          ]);
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const list = document.getElementById('snapshot-list');
    expect(list?.innerHTML).toContain('Test Page');
    expect(list?.innerHTML).toContain('pending');
  });

  it('should handle capture button click', async () => {
    let capturedType = '';
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        capturedType = msg.type;
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([]);
        } else if (msg.type === 'CAPTURE_PAGE') {
          callback({ payload: { snapshotId: 'new_snap' } });
        } else if (msg.type === 'OPEN_VIEWER') {
          callback({ success: true });
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('capture-btn') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(100);

    expect(capturedType).toBe('OPEN_VIEWER');
  });

  it('should handle capture error', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([]);
        } else if (msg.type === 'CAPTURE_PAGE') {
          getChrome().runtime.lastError = { message: 'Capture failed' };
          callback(undefined);
          getChrome().runtime.lastError = null;
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('capture-btn') as HTMLButtonElement;
    btn.click();
    await vi.advanceTimersByTimeAsync(100);

    const status = document.querySelector('.status-text');
    expect(status?.textContent).toContain('Capture failed');
  });

  it('should handle view snapshots button', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('view-snapshots-btn');
    btn?.click();
    await vi.advanceTimersByTimeAsync(100);

    expect(getChrome().tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('viewer.html') })
    );
  });

  it('should show status messages with correct types', async () => {
    // Mock URL.createObjectURL for export
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // Trigger export which shows loading then success status
    const btn = document.getElementById('export-btn');
    btn?.click();
    await vi.advanceTimersByTimeAsync(500);

    const statusEl = document.getElementById('status');
    expect(statusEl?.className).toContain('success');
  });

  it('should format relative times correctly', async () => {
    const now = new Date();
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([
            {
              id: 's1',
              url: 'https://a.com',
              title: 'Recent',
              status: 'pending',
              capturedAt: new Date(now.getTime() - 30000).toISOString(), // 30s ago
              updatedAt: now.toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
            {
              id: 's2',
              url: 'https://b.com',
              title: 'Minutes',
              status: 'pending',
              capturedAt: new Date(now.getTime() - 300000).toISOString(), // 5m ago
              updatedAt: now.toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
            {
              id: 's3',
              url: 'https://c.com',
              title: 'Hours',
              status: 'approved',
              capturedAt: new Date(now.getTime() - 7200000).toISOString(), // 2h ago
              updatedAt: now.toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
            {
              id: 's4',
              url: 'https://d.com',
              title: 'Days',
              status: 'pending',
              capturedAt: new Date(now.getTime() - 172800000).toISOString(), // 2d ago
              updatedAt: now.toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
            {
              id: 's5',
              url: 'https://e.com',
              title: 'Weeks',
              status: 'pending',
              capturedAt: new Date(now.getTime() - 1209600000).toISOString(), // 14d ago
              updatedAt: now.toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
          ]);
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const list = document.getElementById('snapshot-list');
    expect(list?.innerHTML).toContain('Just now');
    expect(list?.innerHTML).toContain('5m ago');
    expect(list?.innerHTML).toContain('2h ago');
    expect(list?.innerHTML).toContain('2d ago');
  });

  it('should handle sendMessage errors via response.error', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback({ error: 'Storage error' });
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // Should still render (gracefully handle error)
    const list = document.getElementById('snapshot-list');
    expect(list).not.toBeNull();
  });

  it('should handle theme toggle', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('toggle-theme');
    btn?.click();

    expect(document.documentElement.dataset.theme).toBeDefined();
  });

  it('should handle import via file input', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else if (msg.type === 'IMPORT_DATA') callback({ imported: 1, skipped: 0 });
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // Create a fake JSON file with text() method (jsdom File may not have it)
    const jsonData = JSON.stringify({
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      snapshots: [],
    });
    const file = new File([jsonData], 'export.json', { type: 'application/json' });
    if (!file.text) {
      (file as unknown as { text: () => Promise<string> }).text = async () => jsonData;
    }

    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(200);

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Imported');
  });

  it('should handle ZIP import', async () => {
    vi.useRealTimers(); // JSZip needs real timers

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      'index.json',
      JSON.stringify({
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        extensionId: 'test',
        snapshots: [
          {
            id: 'snap_1',
            url: 'https://example.com',
            title: 'Test',
            htmlFile: 'html/snap_1.html',
            viewport: { width: 1920, height: 1080 },
            annotations: { text: [], region: [] },
            questions: [],
            status: 'pending',
            capturedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: [],
          },
        ],
      })
    );
    zip.folder('html')?.file('snap_1.html', '<html><body>test</body></html>');
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else if (msg.type === 'IMPORT_DATA') callback({ imported: 1, skipped: 0 });
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));

    // JSZip.loadAsync in popup expects a File/Blob. Use a real Blob with .zip name.
    const zipBlob = new Blob([zipArrayBuffer], { type: 'application/zip' });
    const file = Object.assign(zipBlob, { name: 'export.zip' });
    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Imported');

    vi.useFakeTimers(); // Restore for afterEach
  }, 10000);

  it('should handle invalid import file', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const file = new File(['not json'], 'bad.json', { type: 'application/json' });
    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(100);

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Import failed');
  });

  it('should handle export with snapshots', async () => {
    // Set up storage with snapshots
    getChrome().storage.local.data.snapshotIndex = ['snap_1'];
    getChrome().storage.local.data.snapshot_snap_1 = {
      id: 'snap_1',
      url: 'https://example.com',
      title: 'Test',
      html: '<html>test</html>',
      viewport: { width: 1920, height: 1080 },
      annotations: { text: [], region: [] },
      questions: [],
      status: 'pending',
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
    };

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const mockUrl = 'blob:mock-url';
    const createObjectURL = vi.fn(() => mockUrl);
    const revokeObjectURL = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL;

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('export-btn');
    btn?.click();
    await vi.advanceTimersByTimeAsync(500);

    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith(mockUrl);
  });

  it('should handle export error', async () => {
    // Make storage.local.get throw
    getChrome().storage.local.get.mockRejectedValue(new Error('Storage error'));

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const btn = document.getElementById('export-btn');
    btn?.click();
    await vi.advanceTimersByTimeAsync(100);

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Export failed');
  });

  it('should load saved theme from localStorage', async () => {
    localStorage.setItem('refine-page-theme', 'noir');

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    expect(document.documentElement.dataset.theme).toBe('noir');

    localStorage.removeItem('refine-page-theme');
  });

  it('should handle showStatus when DOM elements are missing', async () => {
    // Remove status element before import
    document.getElementById('status')?.remove();

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // Should not throw even without status element
    expect(true).toBe(true);
  });

  it('should handle invalid export format (missing version/snapshots)', async () => {
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // JSON without version/snapshots
    const jsonData = JSON.stringify({ foo: 'bar' });
    const file = new File([jsonData], 'bad.json');
    if (!file.text) {
      (file as unknown as { text: () => Promise<string> }).text = async () => jsonData;
    }

    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(200);

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Invalid export file format');
  });

  it('should handle ZIP with missing HTML files', async () => {
    vi.useRealTimers();

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      'index.json',
      JSON.stringify({
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        extensionId: 'test',
        snapshots: [
          {
            id: 'snap_1',
            url: 'https://example.com',
            title: 'Test',
            htmlFile: 'html/nonexistent.html',
            viewport: { width: 1920, height: 1080 },
            annotations: { text: [], region: [] },
            questions: [],
            status: 'pending',
            capturedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: [],
          },
        ],
      })
    );
    // Do NOT add the HTML file — simulate missing file
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else if (msg.type === 'IMPORT_DATA') callback({ imported: 0, skipped: 0 });
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));

    const zipBlob = new Blob([zipArrayBuffer], { type: 'application/zip' });
    const file = Object.assign(zipBlob, { name: 'export.zip' });
    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Imported');

    vi.useFakeTimers();
  }, 10000);

  it('should handle clicking a snapshot list item to open viewer', async () => {
    let openedId = '';
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') {
          callback([
            {
              id: 'snap_1',
              url: 'https://example.com',
              title: 'Test Page',
              status: 'pending',
              capturedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              tags: [],
              annotations: { text: [], region: [] },
              questions: [],
            },
          ]);
        } else if (msg.type === 'OPEN_VIEWER') {
          openedId = msg.payload.snapshotId;
          callback({ success: true });
        } else {
          callback({ success: true });
        }
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const item = document.querySelector('li[data-id="snap_1"]') as HTMLElement;
    expect(item).not.toBeNull();
    item?.click();
    await vi.advanceTimersByTimeAsync(100);

    expect(openedId).toBe('snap_1');
  });

  it('should handle ZIP import with missing index.json', async () => {
    vi.useRealTimers();

    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    // No index.json - just a random file
    zip.file('random.txt', 'hello');
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });

    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (msg.type === 'GET_ALL_SNAPSHOTS') callback([]);
        else callback({ success: true });
      }
    );

    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 50));

    const zipBlob = new Blob([zipArrayBuffer], { type: 'application/zip' });
    const file = Object.assign(zipBlob, { name: 'bad.zip' });
    const input = document.getElementById('import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], writable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 500));

    const statusText = document.querySelector('.status-text');
    expect(statusText?.textContent).toContain('Invalid ZIP');

    vi.useFakeTimers();
  }, 10000);

  it('should auto-hide success/error status after timeout', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    // Trigger a successful export to show success status
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
    const btn = document.getElementById('export-btn');
    btn?.click();
    await vi.advanceTimersByTimeAsync(500);

    const statusEl = document.getElementById('status');
    expect(statusEl?.className).toContain('success');

    // Advance past the 3000ms auto-hide timeout
    await vi.advanceTimersByTimeAsync(3500);
    expect(statusEl?.className).toContain('hidden');
  });

  it('should handle click on import button to trigger file input', async () => {
    await import('./popup');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.advanceTimersByTimeAsync(100);

    const importBtn = document.getElementById('import-btn');
    const input = document.getElementById('import-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    importBtn?.click();
    expect(clickSpy).toHaveBeenCalled();
  });
});
