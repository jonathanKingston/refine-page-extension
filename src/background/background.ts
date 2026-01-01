/**
 * Background service worker for refine.page extension
 * Handles cross-component communication, storage operations, and page capture via Chrome MHTML API
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';
import mhtml2html from 'mhtml2html';

// Generate unique ID
function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Make snapshot inert - disable all interactive elements
function makeInert(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all scripts
  doc.querySelectorAll('script').forEach((el) => el.remove());
  doc.querySelectorAll('noscript').forEach((el) => el.remove());

  // Disable all links
  doc.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href) {
      link.setAttribute('data-original-href', href);
      link.removeAttribute('href');
    }
  });

  // Disable forms
  doc.querySelectorAll('form').forEach((form) => {
    form.removeAttribute('action');
    form.setAttribute('onsubmit', 'return false;');
  });

  // Disable interactive elements
  doc.querySelectorAll('button, input, select, textarea').forEach((el) => {
    el.setAttribute('disabled', 'disabled');
  });

  // Remove event handler attributes
  const eventAttrs = ['onclick', 'onmouseover', 'onmouseout', 'onload', 'onerror', 'onsubmit', 'onchange', 'onfocus', 'onblur'];
  doc.querySelectorAll('*').forEach((el) => {
    eventAttrs.forEach((attr) => el.removeAttribute(attr));
  });

  // Add meta tag to identify as refine.page snapshot
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'refine-page-snapshot');
  meta.setAttribute('content', 'true');
  meta.setAttribute('data-captured-at', new Date().toISOString());
  doc.head?.appendChild(meta);

  // Add strict CSP meta tag - allow inline styles since MHTML inlines everything
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', "default-src 'self' data: blob:; script-src 'none'; style-src 'unsafe-inline' data: blob:; font-src data: blob:; img-src 'self' data: blob:; frame-src 'none'; object-src 'none';");
  doc.head?.insertBefore(cspMeta, doc.head.firstChild);

  // Add inert styles
  const inertStyle = doc.createElement('style');
  inertStyle.textContent = `
    a[data-original-href] { cursor: default !important; pointer-events: none !important; }
    button:disabled, input:disabled, select:disabled, textarea:disabled { opacity: 0.7; }
  `;
  doc.head?.appendChild(inertStyle);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// Capture page using Chrome's MHTML API and convert to HTML
async function capturePageAsMhtml(tabId: number): Promise<{ html: string; title: string }> {
  console.log('refine.page: Capturing page as MHTML for tab', tabId);
  const startTime = Date.now();

  // Capture the page as MHTML
  const mhtmlBlob = await chrome.pageCapture.saveAsMHTML({ tabId });
  if (!mhtmlBlob) {
    throw new Error('Failed to capture page as MHTML');
  }

  console.log('refine.page: MHTML captured, size:', (mhtmlBlob.size / 1024).toFixed(1), 'KB');

  // Read the MHTML blob as text
  const mhtmlText = await mhtmlBlob.text();

  // Convert MHTML to HTML document using mhtml2html
  console.log('refine.page: Converting MHTML to HTML...');
  const htmlDoc = mhtml2html.convert(mhtmlText);

  // Get the HTML string from the document
  const htmlString = '<!DOCTYPE html>\n' + htmlDoc.documentElement.outerHTML;
  const title = htmlDoc.title || 'Untitled';

  const duration = Date.now() - startTime;
  console.log(`refine.page: Conversion complete in ${duration}ms, HTML size: ${(htmlString.length / 1024).toFixed(1)}KB`);

  return { html: htmlString, title };
}

// Storage operations using chrome.storage.local
async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const key = `snapshot_${snapshot.id}`;
  await chrome.storage.local.set({ [key]: snapshot });

  // Update the index
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];
  if (!index.includes(snapshot.id)) {
    index.push(snapshot.id);
    await chrome.storage.local.set({ snapshotIndex: index });
  }
}

async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const key = `snapshot_${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key];
}

// Lightweight snapshot summary for listing (excludes HTML to avoid message size limits)
interface SnapshotSummary {
  id: string;
  url: string;
  title: string;
  status: Snapshot['status'];
  capturedAt: string;
  updatedAt: string;
  tags: string[];
  annotationCount: { text: number; region: number };
  questionCount: number;
}

async function getAllSnapshots(): Promise<Snapshot[]> {
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];

  const snapshots: Snapshot[] = [];
  for (const id of index) {
    const snapshot = await getSnapshot(id);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots.sort((a, b) =>
    new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
  );
}

// Get lightweight summaries for listing - avoids 64MB message limit
async function getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];

  const summaries: SnapshotSummary[] = [];
  for (const id of index) {
    const snapshot = await getSnapshot(id);
    if (snapshot) {
      summaries.push({
        id: snapshot.id,
        url: snapshot.url,
        title: snapshot.title,
        status: snapshot.status,
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.updatedAt,
        tags: snapshot.tags,
        annotationCount: {
          text: snapshot.annotations.text.length,
          region: snapshot.annotations.region.length,
        },
        questionCount: snapshot.questions.length,
      });
    }
  }

  return summaries.sort((a, b) =>
    new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
  );
}

async function deleteSnapshot(id: string): Promise<void> {
  const key = `snapshot_${id}`;
  await chrome.storage.local.remove(key);

  // Update the index
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];
  const newIndex = index.filter((i) => i !== id);
  await chrome.storage.local.set({ snapshotIndex: newIndex });
}

async function updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | undefined> {
  const existing = await getSnapshot(id);
  if (!existing) return undefined;

  const updated: Snapshot = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await saveSnapshot(updated);
  return updated;
}

// Export all data
async function exportAllData(): Promise<ExportData> {
  const snapshots = await getAllSnapshots();
  const extensionId = chrome.runtime.id;
  const baseViewerUrl = chrome.runtime.getURL('viewer.html');

  // Add viewer URLs to each snapshot
  const exportedSnapshots: ExportedSnapshot[] = snapshots.map((snapshot) => ({
    ...snapshot,
    viewerUrl: `${baseViewerUrl}?id=${snapshot.id}`,
  }));

  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    extensionId,
    snapshots: exportedSnapshots,
  };
}

// Import data
async function importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const snapshot of data.snapshots) {
    const existing = await getSnapshot(snapshot.id);
    if (existing) {
      skipped++;
    } else {
      await saveSnapshot(snapshot);
      imported++;
    }
  }

  return { imported, skipped };
}

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Skip messages without a type (e.g., from other extensions)
  if (!message?.type) {
    return false;
  }

  const handleMessage = async (): Promise<unknown> => {
    switch (message.type) {
      case 'GET_ALL_SNAPSHOTS':
        return getAllSnapshotSummaries(); // Use lightweight summaries to avoid 64MB limit

      case 'GET_SNAPSHOT':
        return getSnapshot(message.payload.id);

      case 'SAVE_SNAPSHOT':
        await saveSnapshot(message.payload.snapshot);
        return { success: true };

      case 'UPDATE_SNAPSHOT':
        return updateSnapshot(message.payload.id, message.payload.updates);

      case 'DELETE_SNAPSHOT':
        await deleteSnapshot(message.payload.id);
        return { success: true };

      case 'EXPORT_DATA':
        return exportAllData();

      case 'IMPORT_DATA':
        return importData(message.payload.data);

      case 'OPEN_VIEWER':
        const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${message.payload.snapshotId}`);
        await chrome.tabs.create({ url: viewerUrl });
        return { success: true };

      case 'CAPTURE_PAGE': {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab?.url) {
          throw new Error('No active tab found');
        }

        // Check if the tab URL is capturable (not chrome://, chrome-extension://, etc.)
        const url = tab.url;
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
            url.startsWith('edge://') || url.startsWith('about:') ||
            url.startsWith('devtools://')) {
          throw new Error('Cannot capture browser internal pages');
        }

        try {
          // Get page metadata from content script
          let metadata: { url: string; title: string; viewport: { width: number; height: number } };
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_METADATA' });
            metadata = response.payload;
          } catch {
            // Content script not loaded - inject it and try again
            console.log('Content script not loaded, injecting...');
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js'],
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_METADATA' });
            metadata = response.payload;
          }

          // Capture the page as MHTML and convert to HTML
          const { html } = await capturePageAsMhtml(tab.id);

          // Make the snapshot inert
          const inertHtml = makeInert(html);

          // Create the snapshot
          const snapshot: Snapshot = {
            id: generateId(),
            url: metadata.url,
            title: metadata.title,
            html: inertHtml,
            viewport: metadata.viewport,
            annotations: { text: [], region: [] },
            questions: [],
            status: 'pending',
            capturedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: [],
          };

          // Save the snapshot
          await saveSnapshot(snapshot);

          console.log(`refine.page: Snapshot saved, id: ${snapshot.id}, size: ${(inertHtml.length / 1024).toFixed(1)}KB`);

          return { type: 'CAPTURE_COMPLETE', payload: { snapshotId: snapshot.id } };
        } catch (error) {
          console.error('refine.page: Capture error:', error);
          return { type: 'CAPTURE_ERROR', payload: { error: (error as Error).message || 'Unknown error' } };
        }
      }

      default:
        // Unknown message type - don't handle it
        return undefined;
    }
  };

  // Check if this is a message type we handle
  const knownTypes = ['GET_ALL_SNAPSHOTS', 'GET_SNAPSHOT', 'SAVE_SNAPSHOT', 'UPDATE_SNAPSHOT',
                      'DELETE_SNAPSHOT', 'EXPORT_DATA', 'IMPORT_DATA', 'OPEN_VIEWER', 'CAPTURE_PAGE'];
  if (!knownTypes.includes(message.type)) {
    return false; // Let other listeners handle it
  }

  handleMessage()
    .then(sendResponse)
    .catch((error) => {
      console.error('Background script error:', error);
      sendResponse({ error: error.message });
    });

  return true; // Indicates async response
});

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('refine.page extension installed');
    // Initialize storage
    chrome.storage.local.set({ snapshotIndex: [] });
  }
});

console.log('refine.page: Background service worker started');
