/**
 * Background service worker for Page Labeller extension
 * Handles cross-component communication and storage operations
 */

import type { Snapshot, ExportData } from '@/types';

// Generate unique ID
function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    snapshots,
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
  // Ignore messages without a type or from SingleFile internal messaging
  if (!message || !message.type) {
    return false;
  }

  // Ignore SingleFile internal messages (lazy loading coordination)
  const singleFileMessages = ['idleTimeout', 'maxTimeout', 'loadDeferredImages'];
  if (singleFileMessages.includes(message.type)) {
    return false;
  }

  const handleMessage = async () => {
    switch (message.type) {
      case 'GET_ALL_SNAPSHOTS':
        return getAllSnapshots();

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
        // Open the viewer in a new tab with the snapshot ID
        const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${message.payload.snapshotId}`);
        await chrome.tabs.create({ url: viewerUrl });
        return { success: true };

      case 'CAPTURE_PAGE':
        // Send message to content script to capture the page
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_PAGE' });
          return response;
        }
        throw new Error('No active tab found');

      default:
        // Log unknown messages for debugging but don't throw
        console.warn('Unknown message type:', message.type);
        return { error: `Unknown message type: ${message.type}` };
    }
  };

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
    console.log('Page Labeller extension installed');
    // Initialize storage
    chrome.storage.local.set({ snapshotIndex: [] });
  }
});

console.log('Page Labeller: Background service worker started');
