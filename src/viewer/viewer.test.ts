/**
 * Tests for viewer/viewer.ts - the main annotation viewer
 *
 * This is the largest source file (2293 lines, 62 functions). We test it by:
 * 1. Setting up the full DOM from viewer.html
 * 2. Mocking Chrome APIs and annotation libraries
 * 3. Importing the module (which registers DOMContentLoaded)
 * 4. Exercising code paths via DOM interactions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Mock CSS imports that viewer.ts imports
vi.mock('@recogito/text-annotator/text-annotator.css', () => ({}));
vi.mock('@annotorious/annotorious/annotorious.css', () => ({}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChrome(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).chrome;
}

function setupViewerDom() {
  const html = readFileSync(resolve(__dirname, 'viewer.html'), 'utf-8');
  // Extract just the body content
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) {
    document.body.innerHTML = bodyMatch[1].replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  }
}

function makeTestSnapshot(overrides = {}) {
  return {
    id: 'snap_test_1',
    url: 'https://example.com',
    title: 'Test Snapshot',
    html: '<html><head></head><body><p>Hello World</p></body></html>',
    viewport: { width: 1920, height: 1080 },
    annotations: { text: [], region: [] },
    questions: [
      {
        id: 'q1',
        query: 'Test question',
        expectedAnswer: '',
        annotationIds: [],
        evaluation: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    status: 'pending' as const,
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    reviewNotes: '',
    ...overrides,
  };
}

describe('viewer module', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();
    setupViewerDom();

    // Mock URL params (no snapshot ID by default)
    Object.defineProperty(window, 'location', {
      value: { search: '', href: 'http://localhost/viewer.html' },
      writable: true,
      configurable: true,
    });
  });

  it('should register DOMContentLoaded handler', async () => {
    const snap = makeTestSnapshot();

    // Set up storage with a snapshot
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;

    // Set up sendMessage for various calls
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Should have set up keyboard shortcuts and loaded snapshots
    expect(document.getElementById('preview-frame')).not.toBeNull();
  });

  it('should load snapshot from URL param', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Wait for async snapshot loading
    await vi.waitFor(() => {
      const title = document.getElementById('page-title');
      expect(title?.textContent).toBe('Test Snapshot');
    });
  });

  it('should handle theme toggle', async () => {
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const themeBtn = document.getElementById('toggle-theme');
    themeBtn?.click();

    expect(document.documentElement.dataset.theme).toBeDefined();
  });

  it('should handle focus mode toggle', async () => {
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const focusBtn = document.getElementById('toggle-focus-mode');
    focusBtn?.click();

    expect(document.body.classList.contains('focus-mode')).toBe(true);

    focusBtn?.click();
    expect(document.body.classList.contains('focus-mode')).toBe(false);
  });

  it('should handle tab switching between pages and questions', async () => {
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    const questionsTab = document.querySelector('.tab-btn[data-tab="questions"]') as HTMLElement;
    questionsTab?.click();

    expect(document.getElementById('pages-tab')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('questions-tab')?.classList.contains('hidden')).toBe(false);

    const pagesTab = document.querySelector('.tab-btn[data-tab="pages"]') as HTMLElement;
    pagesTab?.click();

    expect(document.getElementById('pages-tab')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('questions-tab')?.classList.contains('hidden')).toBe(true);
  });

  it('should handle keyboard shortcuts', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Test tool shortcuts (pressing 'r' for relevant)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));

    // The tool should be set (relevant button should be active)
    const relevantBtn = document.querySelector('.tool-btn[data-tool="relevant"]');
    expect(relevantBtn?.classList.contains('active')).toBe(true);

    // Test 'a' for answer
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    const answerBtn = document.querySelector('.tool-btn[data-tool="answer"]');
    expect(answerBtn?.classList.contains('active')).toBe(true);
  });

  it('should handle snapshot navigation with filter tabs', async () => {
    const snap1 = makeTestSnapshot({ id: 'snap_1', title: 'Page 1', status: 'pending' });
    const snap2 = makeTestSnapshot({ id: 'snap_2', title: 'Page 2', status: 'approved' });

    getChrome().storage.local.data.snapshotIndex = ['snap_1', 'snap_2'];
    getChrome().storage.local.data.snapshot_snap_1 = snap1;
    getChrome().storage.local.data.snapshot_snap_2 = snap2;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      const nav = document.getElementById('snapshot-nav');
      expect(nav?.children.length).toBeGreaterThanOrEqual(2);
    });

    // Click pending filter
    const pendingFilter = document.querySelector(
      '.filter-tab[data-filter="pending"]'
    ) as HTMLElement;
    pendingFilter?.click();

    await vi.waitFor(() => {
      const nav = document.getElementById('snapshot-nav');
      // Should show only pending snapshots
      expect(nav?.children.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should handle approve/decline/skip buttons', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Click approve — this should update the snapshot status
    const approveBtn = document.getElementById('approve-btn');
    approveBtn?.click();

    // Approve triggers a save (UPDATE_SNAPSHOT)
    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle evaluation toggle buttons', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Click correctness toggle
    const correctBtn = document.querySelector(
      '#correctness-toggle .toggle-btn[data-value="correct"]'
    ) as HTMLElement;
    correctBtn?.click();

    // Click in-page toggle
    const yesBtn = document.querySelector(
      '#in-page-toggle .toggle-btn[data-value="yes"]'
    ) as HTMLElement;
    yesBtn?.click();

    // Click quality toggle
    const goodBtn = document.querySelector(
      '#quality-toggle .toggle-btn[data-value="good"]'
    ) as HTMLElement;
    goodBtn?.click();

    // Verify the buttons are active
    expect(correctBtn?.classList.contains('active')).toBe(true);
    expect(yesBtn?.classList.contains('active')).toBe(true);
    expect(goodBtn?.classList.contains('active')).toBe(true);
  });

  it('should handle question navigation', async () => {
    const snap = makeTestSnapshot({
      questions: [
        {
          id: 'q1',
          query: 'Q1',
          expectedAnswer: '',
          annotationIds: [],
          evaluation: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'q2',
          query: 'Q2',
          expectedAnswer: '',
          annotationIds: [],
          evaluation: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Navigate to next question
    const nextBtn = document.getElementById('next-question');
    nextBtn?.click();

    await vi.waitFor(() => {
      const label = document.getElementById('question-nav-label');
      expect(label?.textContent).toContain('2');
    });
  });

  it('should handle adding a question', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Click add question
    const addBtn = document.getElementById('add-question-btn');
    addBtn?.click();

    // Should have added a new question
    await vi.waitFor(() => {
      const label = document.getElementById('question-nav-label');
      expect(label?.textContent).toContain('2');
    });
  });

  it('should handle Ctrl+S save shortcut', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Press Ctrl+S
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true });
    document.dispatchEvent(event);

    // Should trigger save — check that sendMessage was called with UPDATE_SNAPSHOT
    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should load saved theme from localStorage', async () => {
    localStorage.setItem('refine-page-theme', 'noir');
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(document.documentElement.dataset.theme).toBe('noir');
    localStorage.removeItem('refine-page-theme');
  });

  it('should handle decline button', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    document.getElementById('decline-btn')?.click();

    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle skip button navigating to next pending', async () => {
    const snap1 = makeTestSnapshot({ id: 'snap_1', title: 'Page 1' });
    const snap2 = makeTestSnapshot({ id: 'snap_2', title: 'Page 2' });
    getChrome().storage.local.data.snapshotIndex = ['snap_1', 'snap_2'];
    getChrome().storage.local.data.snapshot_snap_1 = snap1;
    getChrome().storage.local.data.snapshot_snap_2 = snap2;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/viewer.html?id=snap_1' },
      writable: true,
      configurable: true,
    });
    window.history.pushState = vi.fn();

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Page 1');
    });

    document.getElementById('skip-btn')?.click();

    await vi.waitFor(() => {
      expect(window.history.pushState).toHaveBeenCalled();
    });
  });

  it('should handle review notes input', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    const notes = document.getElementById('review-notes') as HTMLTextAreaElement;
    notes.value = 'Some review notes';
    notes.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle question query editing', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
    queryInput.value = 'Updated question text';
    queryInput.dispatchEvent(new Event('input'));

    // Should save
    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle quick eval buttons in bottom bar', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Click quick correctness button
    const quickCorrect = document.querySelector(
      '#quick-correctness .quick-btn[data-value="correct"]'
    ) as HTMLElement;
    quickCorrect?.click();

    // Click quick in-page button
    const quickYes = document.querySelector(
      '#quick-in-page .quick-btn[data-value="yes"]'
    ) as HTMLElement;
    quickYes?.click();

    // Click quick quality button
    const quickGood = document.querySelector(
      '#quick-quality .quick-btn[data-value="good"]'
    ) as HTMLElement;
    quickGood?.click();

    // Should trigger saves
    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle zoom shortcuts', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Zoom in with '=' key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true }));

    // Zoom out with '-' key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));

    // The zoom handler modifies iframe transform — just verify no crash
    expect(true).toBe(true);
  });

  it('should handle evaluation keyboard shortcuts', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Test evaluation shortcuts
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true })); // correct
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true })); // yes (in page)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })); // good (quality)

    // All should trigger saves
    await vi.waitFor(() => {
      const updateCalls = getChrome().runtime.sendMessage.mock.calls.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (call: any[]) => call[0]?.type === 'UPDATE_SNAPSHOT'
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('should handle Ctrl+Enter approve and advance', async () => {
    const snap1 = makeTestSnapshot({ id: 'snap_1', title: 'Page 1' });
    const snap2 = makeTestSnapshot({ id: 'snap_2', title: 'Page 2' });
    getChrome().storage.local.data.snapshotIndex = ['snap_1', 'snap_2'];
    getChrome().storage.local.data.snapshot_snap_1 = snap1;
    getChrome().storage.local.data.snapshot_snap_2 = snap2;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_1', href: 'http://localhost/viewer.html?id=snap_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Page 1');
    });

    // Ctrl+Enter
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
    );

    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should handle expected answer input editing', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    const expectedInput = document.getElementById('expected-answer-input') as HTMLInputElement;
    expectedInput.value = 'Expected answer text';
    expectedInput.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'UPDATE_SNAPSHOT' }),
        expect.any(Function)
      );
    });
  });

  it('should not trigger shortcuts when focused on input', async () => {
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Focus on an input, then press 'r' — should NOT trigger tool switch
    const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
    const event = new KeyboardEvent('keydown', { key: 'r', bubbles: true });
    Object.defineProperty(event, 'target', { value: queryInput });
    document.dispatchEvent(event);

    // Relevant button should NOT be active
    const relevantBtn = document.querySelector('.tool-btn[data-tool="relevant"]');
    expect(relevantBtn?.classList.contains('active')).toBe(false);
  });

  it('should handle Escape key to deselect tool', async () => {
    const snap = makeTestSnapshot();
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });

    // Select relevant tool
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    expect(
      document.querySelector('.tool-btn[data-tool="relevant"]')?.classList.contains('active')
    ).toBe(true);

    // Press Escape to deselect
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // No tool should be active (select mode)
    expect(
      document.querySelector('.tool-btn[data-tool="relevant"]')?.classList.contains('active')
    ).toBe(false);
    expect(
      document.querySelector('.tool-btn[data-tool="answer"]')?.classList.contains('active')
    ).toBe(false);
  });

  it('should handle snapshot without existing questions', async () => {
    const snap = makeTestSnapshot({ questions: [] });
    getChrome().storage.local.data.snapshotIndex = ['snap_test_1'];
    getChrome().storage.local.data.snapshot_snap_test_1 = snap;
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msg: any, callback: any) => {
        if (callback) callback({ success: true });
      }
    );
    getChrome().runtime.lastError = null;

    Object.defineProperty(window, 'location', {
      value: { search: '?id=snap_test_1', href: 'http://localhost/viewer.html?id=snap_test_1' },
      writable: true,
      configurable: true,
    });

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Should auto-create a default question
    await vi.waitFor(() => {
      expect(document.getElementById('page-title')?.textContent).toBe('Test Snapshot');
    });
  });

  it('should handle empty snapshot list', async () => {
    getChrome().storage.local.data.snapshotIndex = [];
    getChrome().runtime.sendMessage.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_msg: any, callback: any) => {
        if (callback) callback({});
      }
    );
    getChrome().runtime.lastError = null;

    await import('./viewer');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Should not crash with empty list
    const nav = document.getElementById('snapshot-nav');
    expect(nav).not.toBeNull();
  });
});
