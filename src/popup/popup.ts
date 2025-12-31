/**
 * Popup script for Page Labeller extension
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';

// Direct storage access functions to bypass message size limits
async function getSnapshotIndex(): Promise<string[]> {
  const result = await chrome.storage.local.get('snapshotIndex');
  return result.snapshotIndex || [];
}

async function getSnapshotFromStorage(id: string): Promise<Snapshot | null> {
  const key = `snapshot_${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function getAllSnapshotsFromStorage(): Promise<Snapshot[]> {
  const index = await getSnapshotIndex();
  const keys = index.map((id) => `snapshot_${id}`);
  if (keys.length === 0) return [];
  const result = await chrome.storage.local.get(keys);
  return keys
    .map((key) => result[key])
    .filter(Boolean)
    .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());
}

// Send message to background script
async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// Show status message
function showStatus(message: string, type: 'success' | 'error' | 'loading') {
  const statusEl = document.getElementById('status');
  const textEl = statusEl?.querySelector('.status-text');
  if (!statusEl || !textEl) return;

  statusEl.className = `status ${type}`;
  textEl.textContent = message;

  if (type !== 'loading') {
    setTimeout(() => {
      statusEl.classList.add('hidden');
    }, 3000);
  }
}

// Format relative time
function formatRelativeTime(date: string): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

// Update statistics display
async function updateStats() {
  try {
    const snapshots = await sendMessage<Snapshot[]>('GET_ALL_SNAPSHOTS');

    const totalEl = document.getElementById('total-count');
    const pendingEl = document.getElementById('pending-count');
    const approvedEl = document.getElementById('approved-count');

    if (totalEl) totalEl.textContent = String(snapshots.length);
    if (pendingEl) {
      pendingEl.textContent = String(
        snapshots.filter((s) => s.status === 'pending').length
      );
    }
    if (approvedEl) {
      approvedEl.textContent = String(
        snapshots.filter((s) => s.status === 'approved').length
      );
    }

    return snapshots;
  } catch (error) {
    console.error('Failed to get stats:', error);
    return [];
  }
}

// Render snapshot list
async function renderSnapshotList() {
  const listEl = document.getElementById('snapshot-list');
  if (!listEl) return;

  const snapshots = await updateStats();

  if (snapshots.length === 0) {
    listEl.innerHTML = '<li class="empty-state">No snapshots yet</li>';
    return;
  }

  // Show only the 5 most recent
  const recent = snapshots.slice(0, 5);

  listEl.innerHTML = recent
    .map(
      (snapshot) => `
      <li data-id="${snapshot.id}">
        <div class="snapshot-item">
          <div>
            <div class="snapshot-title">${escapeHtml(snapshot.title || 'Untitled')}</div>
            <div class="snapshot-meta">${formatRelativeTime(snapshot.capturedAt)}</div>
          </div>
          <span class="snapshot-status ${snapshot.status}">${snapshot.status}</span>
        </div>
      </li>
    `
    )
    .join('');

  // Add click handlers
  listEl.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => {
      const id = li.getAttribute('data-id');
      if (id) openViewer(id);
    });
  });
}

// Escape HTML
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Open viewer for a snapshot
async function openViewer(snapshotId: string) {
  await sendMessage('OPEN_VIEWER', { snapshotId });
}

// Capture current page
async function capturePage() {
  const captureBtn = document.getElementById('capture-btn') as HTMLButtonElement;
  if (captureBtn) captureBtn.disabled = true;

  showStatus('Capturing page...', 'loading');

  try {
    const response = await sendMessage<{ payload: { snapshotId: string } }>('CAPTURE_PAGE');
    showStatus('Page captured successfully!', 'success');

    // Refresh the list
    await renderSnapshotList();

    // Open the viewer
    if (response?.payload?.snapshotId) {
      await openViewer(response.payload.snapshotId);
    }
  } catch (error) {
    showStatus(`Capture failed: ${(error as Error).message}`, 'error');
  } finally {
    if (captureBtn) captureBtn.disabled = false;
  }
}

// Export all data - uses direct storage access to bypass message size limits
async function exportData() {
  try {
    showStatus('Exporting data...', 'loading');

    // Access storage directly to avoid message passing size limits
    const snapshots = await getAllSnapshotsFromStorage();
    const baseViewerUrl = chrome.runtime.getURL('viewer.html');

    // Add viewer URLs to each snapshot
    const exportedSnapshots: ExportedSnapshot[] = snapshots.map((snapshot) => ({
      ...snapshot,
      viewerUrl: `${baseViewerUrl}?id=${snapshot.id}`,
    }));

    const data: ExportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      extensionId: chrome.runtime.id,
      snapshots: exportedSnapshots,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `page-labeller-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
    showStatus(`Exported ${data.snapshots.length} snapshots`, 'success');
  } catch (error) {
    showStatus(`Export failed: ${(error as Error).message}`, 'error');
  }
}

// Import data
async function importData(file: File) {
  try {
    showStatus('Importing data...', 'loading');
    const text = await file.text();
    const data = JSON.parse(text) as ExportData;

    if (!data.version || !data.snapshots) {
      throw new Error('Invalid export file format');
    }

    const result = await sendMessage<{ imported: number; skipped: number }>(
      'IMPORT_DATA',
      { data }
    );

    showStatus(
      `Imported ${result.imported} snapshots (${result.skipped} skipped)`,
      'success'
    );

    await renderSnapshotList();
  } catch (error) {
    showStatus(`Import failed: ${(error as Error).message}`, 'error');
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Render initial state
  await renderSnapshotList();

  // Capture button
  const captureBtn = document.getElementById('capture-btn');
  captureBtn?.addEventListener('click', capturePage);

  // View snapshots button
  const viewBtn = document.getElementById('view-snapshots-btn');
  viewBtn?.addEventListener('click', () => {
    const viewerUrl = chrome.runtime.getURL('viewer.html');
    chrome.tabs.create({ url: viewerUrl });
  });

  // Export button
  const exportBtn = document.getElementById('export-btn');
  exportBtn?.addEventListener('click', exportData);

  // Import button and file input
  const importBtn = document.getElementById('import-btn');
  const importInput = document.getElementById('import-input') as HTMLInputElement;

  importBtn?.addEventListener('click', () => {
    importInput?.click();
  });

  importInput?.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) {
      importData(file);
      importInput.value = ''; // Reset for next import
    }
  });
});
