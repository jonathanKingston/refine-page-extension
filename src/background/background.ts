/**
 * Background service worker for refine.page extension
 * Handles cross-component communication, storage operations, and page capture via Chrome MHTML API
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';

// Generate unique ID
function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Offscreen document management
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreen: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  // Avoid race conditions by checking if we're already creating
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Convert MHTML to HTML using DOM parser',
  });

  try {
    await creatingOffscreen;
    // Small delay to allow the offscreen document's script to register its message listener
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    creatingOffscreen = null;
  }
}

// Capture page using Chrome's MHTML API and convert to HTML via offscreen document
async function capturePageAsMhtml(
  tabId: number,
  pageUrl: string
): Promise<{ html: string; title: string }> {
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

  // Ensure offscreen document exists
  await ensureOffscreenDocument();

  // Send MHTML to offscreen document for conversion
  console.log('refine.page: Sending MHTML to offscreen document for conversion...');
  const response = await chrome.runtime.sendMessage({
    type: 'CONVERT_MHTML',
    payload: { mhtmlText, baseUrl: pageUrl },
  });

  if (!response) {
    throw new Error('No response from offscreen document - it may not have loaded yet');
  }

  if (response.type === 'CONVERT_MHTML_ERROR') {
    throw new Error(response.payload.error);
  }

  const duration = Date.now() - startTime;
  console.log(
    `refine.page: Capture complete in ${duration}ms, HTML size: ${(response.payload.html.length / 1024).toFixed(1)}KB`
  );

  return { html: response.payload.html, title: response.payload.title };
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

  return snapshots.sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
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

  return summaries.sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
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

async function updateSnapshot(
  id: string,
  updates: Partial<Snapshot>
): Promise<Snapshot | undefined> {
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

  // Skip messages from offscreen document (responses)
  if (message.type === 'CONVERT_MHTML_COMPLETE' || message.type === 'CONVERT_MHTML_ERROR') {
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
        if (
          url.startsWith('chrome://') ||
          url.startsWith('chrome-extension://') ||
          url.startsWith('edge://') ||
          url.startsWith('about:') ||
          url.startsWith('devtools://')
        ) {
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
            await new Promise((resolve) => setTimeout(resolve, 100));
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_METADATA' });
            metadata = response.payload;
          }

          // Capture the page as MHTML and convert to HTML (via offscreen document)
          const { html } = await capturePageAsMhtml(tab.id, metadata.url);

          // Create the snapshot
          const snapshot: Snapshot = {
            id: generateId(),
            url: metadata.url,
            title: metadata.title,
            html: html,
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

          console.log(
            `refine.page: Snapshot saved, id: ${snapshot.id}, size: ${(html.length / 1024).toFixed(1)}KB`
          );

          return { type: 'CAPTURE_COMPLETE', payload: { snapshotId: snapshot.id } };
        } catch (error) {
          console.error('refine.page: Capture error:', error);
          return {
            type: 'CAPTURE_ERROR',
            payload: { error: (error as Error).message || 'Unknown error' },
          };
        }
      }

      default:
        // Unknown message type - don't handle it
        return undefined;
    }
  };

  // Check if this is a message type we handle
  const knownTypes = [
    'GET_ALL_SNAPSHOTS',
    'GET_SNAPSHOT',
    'SAVE_SNAPSHOT',
    'UPDATE_SNAPSHOT',
    'DELETE_SNAPSHOT',
    'EXPORT_DATA',
    'IMPORT_DATA',
    'OPEN_VIEWER',
    'CAPTURE_PAGE',
  ];
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
