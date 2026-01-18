/**
 * Popup script for refine.page extension
 */

import type {
  Snapshot,
  ExportData,
  ExportedSnapshot,
  ZipExportData,
  ZipIndexSnapshot,
  Trace,
  RecordingState,
} from '@/types';
import JSZip from 'jszip';

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
function showStatus(message: string, type: 'success' | 'error' | 'loading' | 'info') {
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
      pendingEl.textContent = String(snapshots.filter((s) => s.status === 'pending').length);
    }
    if (approvedEl) {
      approvedEl.textContent = String(snapshots.filter((s) => s.status === 'approved').length);
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

// Export all data as ZIP - uses direct storage access to bypass message size limits
async function exportData() {
  try {
    showStatus('Exporting data...', 'loading');

    // Access storage directly to avoid message passing size limits
    const snapshots = await getAllSnapshotsFromStorage();
    const baseViewerUrl = chrome.runtime.getURL('viewer.html');

    // Create ZIP file
    const zip = new JSZip();
    const htmlFolder = zip.folder('html');

    // Create index with metadata (without HTML content)
    const indexSnapshots = snapshots.map((snapshot) => {
      // Extract everything except the HTML for the index
      const { html, ...metadata } = snapshot;
      return {
        ...metadata,
        htmlFile: `html/${snapshot.id}.html`,
        viewerUrl: `${baseViewerUrl}?id=${snapshot.id}`,
      };
    });

    const indexData: ZipExportData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      extensionId: chrome.runtime.id,
      snapshots: indexSnapshots as ZipIndexSnapshot[],
    };

    // Add index.json to ZIP
    zip.file('index.json', JSON.stringify(indexData, null, 2));

    // Add each snapshot's HTML as a separate file
    for (const snapshot of snapshots) {
      htmlFolder?.file(`${snapshot.id}.html`, snapshot.html);
    }

    // Generate ZIP blob
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `refine-page-export-${new Date().toISOString().split('T')[0]}.zip`;
    a.click();

    URL.revokeObjectURL(url);
    showStatus(`Exported ${snapshots.length} snapshots`, 'success');
  } catch (error) {
    showStatus(`Export failed: ${(error as Error).message}`, 'error');
  }
}

// Import data - supports both ZIP (new) and JSON (legacy) formats
async function importData(file: File) {
  try {
    showStatus('Importing data...', 'loading');

    let data: ExportData;

    if (file.name.endsWith('.zip')) {
      // Handle ZIP format
      const zip = await JSZip.loadAsync(file);

      // Read index.json
      const indexFile = zip.file('index.json');
      if (!indexFile) {
        throw new Error('Invalid ZIP: missing index.json');
      }
      const indexJson = await indexFile.async('string');
      const zipData = JSON.parse(indexJson) as ZipExportData;

      // Reconstruct snapshots with HTML content
      const snapshotsWithHtml: ExportedSnapshot[] = [];
      for (const snapshotMeta of zipData.snapshots) {
        const htmlFile = snapshotMeta.htmlFile || `html/${snapshotMeta.id}.html`;
        const htmlZipFile = zip.file(htmlFile);

        if (htmlZipFile) {
          const html = await htmlZipFile.async('string');
          // Reconstruct full snapshot with HTML
          const { htmlFile: _, ...rest } = snapshotMeta;
          snapshotsWithHtml.push({
            ...rest,
            html,
          } as ExportedSnapshot);
        } else {
          console.warn(`Missing HTML file for snapshot ${snapshotMeta.id}`);
        }
      }

      data = {
        version: zipData.version,
        exportedAt: zipData.exportedAt,
        extensionId: zipData.extensionId,
        snapshots: snapshotsWithHtml,
      };
    } else {
      // Handle legacy JSON format
      const text = await file.text();
      data = JSON.parse(text) as ExportData;
    }

    if (!data.version || !data.snapshots) {
      throw new Error('Invalid export file format');
    }

    const result = await sendMessage<{ imported: number; skipped: number }>('IMPORT_DATA', {
      data,
    });

    showStatus(`Imported ${result.imported} snapshots (${result.skipped} skipped)`, 'success');

    await renderSnapshotList();
  } catch (error) {
    showStatus(`Import failed: ${(error as Error).message}`, 'error');
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved theme
  const savedTheme = localStorage.getItem('refine-page-theme');
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;
  }

  // Theme toggle
  document.getElementById('toggle-theme')?.addEventListener('click', () => {
    const html = document.documentElement;
    const currentTheme = html.dataset.theme || 'pastel';
    html.dataset.theme = currentTheme === 'noir' ? 'pastel' : 'noir';
    localStorage.setItem('refine-page-theme', html.dataset.theme);
  });

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

  // Recording functionality
  await updateRecordingUI();
  setupRecordingHandlers();
});

// Update recording UI based on current state
async function updateRecordingUI() {
  try {
    const state = await sendMessage<RecordingState>('GET_RECORDING_STATE');

    const indicator = document.getElementById('recording-indicator');
    const recordingText = document.getElementById('recording-text');
    const startBtn = document.getElementById('start-recording-btn');
    const stopBtn = document.getElementById('stop-recording-btn');
    const recordingInfo = document.getElementById('recording-info');
    const traceIdEl = document.getElementById('trace-id');
    const interactionCountEl = document.getElementById('interaction-count');

    if (state.isRecording && state.currentTraceId) {
      // Recording active
      if (indicator) {
        indicator.className = 'recording-indicator active';
      }
      if (recordingText) {
        recordingText.textContent = 'Recording...';
      }
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'block';
      if (recordingInfo) recordingInfo.style.display = 'block';
      if (traceIdEl) traceIdEl.textContent = state.currentTraceId.substring(0, 8) + '...';

      // Get interaction count
      const trace = await sendMessage<Trace>('GET_TRACE', { id: state.currentTraceId });
      if (interactionCountEl && trace) {
        interactionCountEl.textContent = String(trace.interactions.length);
      }
    } else {
      // Not recording
      if (indicator) {
        indicator.className = 'recording-indicator';
      }
      if (recordingText) {
        recordingText.textContent = 'Not Recording';
      }
      if (startBtn) startBtn.style.display = 'block';
      if (stopBtn) stopBtn.style.display = 'none';
      if (recordingInfo) recordingInfo.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to update recording UI:', error);
  }
}

// Setup recording button handlers
function setupRecordingHandlers() {
  const startBtn = document.getElementById('start-recording-btn');
  const stopBtn = document.getElementById('stop-recording-btn');

  startBtn?.addEventListener('click', async () => {
    try {
      showStatus('Starting recording...', 'loading');

      // Check if recording is already active (recovery from stuck state)
      const currentState = await sendMessage<RecordingState>('GET_RECORDING_STATE');
      if (currentState.isRecording) {
        const recover = confirm(
          'Recording appears to be active. This might be a stuck state.\n\n' +
            'Click OK to force stop and restart, or Cancel to keep current recording.'
        );
        if (recover) {
          try {
            await sendMessage('STOP_RECORDING');
            // No delay needed - stopRecording is synchronous once it completes
          } catch {
            // Ignore errors when force stopping
          }
        } else {
          showStatus('Recording already active', 'info');
          await updateRecordingUI();
          return;
        }
      }

      const result = await sendMessage<{ traceId: string }>('START_RECORDING');
      showStatus('Recording started!', 'success');
      await updateRecordingUI();

      // Poll for updates
      let interval: ReturnType<typeof setInterval> | null = null;
      let checkStop: ReturnType<typeof setInterval> | null = null;

      interval = setInterval(async () => {
        await updateRecordingUI();
      }, 2000);

      // Clear interval when recording stops
      checkStop = setInterval(async () => {
        const state = await sendMessage<RecordingState>('GET_RECORDING_STATE');
        if (!state.isRecording) {
          if (interval) clearInterval(interval);
          if (checkStop) clearInterval(checkStop);
          await updateRecordingUI();
        }
      }, 1000);
    } catch (error) {
      showStatus(`Failed to start recording: ${(error as Error).message}`, 'error');
      await updateRecordingUI(); // Update UI to reflect actual state
    }
  });

  stopBtn?.addEventListener('click', async () => {
    try {
      showStatus('Stopping recording...', 'loading');
      const result = await sendMessage<{ traceId: string }>('STOP_RECORDING');
      showStatus('Recording stopped!', 'success');
      await updateRecordingUI();

      // Offer to view or export trace
      const choice = confirm(
        'Recording stopped. Would you like to view the trace in the labeller?\n\nClick OK to view, Cancel to skip.'
      );
      if (choice) {
        await openTraceInViewer(result.traceId);
      }
    } catch (error) {
      showStatus(`Failed to stop recording: ${(error as Error).message}`, 'error');
    }
  });
}

// Export trace as ZIP
async function exportTrace(traceId: string) {
  try {
    showStatus('Exporting trace...', 'loading');

    const trace = await sendMessage<Trace>('GET_TRACE', { id: traceId });
    if (!trace) {
      throw new Error('Trace not found');
    }

    // Get all snapshots referenced in the trace
    const snapshotIds = new Set<string>();

    // Include initial and final snapshots
    if (trace.initialSnapshotId) {
      snapshotIds.add(trace.initialSnapshotId);
    }
    if (trace.finalSnapshotId) {
      snapshotIds.add(trace.finalSnapshotId);
    }

    // Include pre/post snapshots from interactions
    for (const interaction of trace.interactions) {
      snapshotIds.add(interaction.preSnapshotId);
      snapshotIds.add(interaction.postSnapshotId);
    }

    const snapshots: Snapshot[] = [];
    for (const id of snapshotIds) {
      const snapshot = await getSnapshotFromStorage(id);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    // Create ZIP file
    const zip = new JSZip();

    // Add trace metadata
    zip.file('trace.json', JSON.stringify(trace, null, 2));

    // Add interactions as JSONL
    const interactionsJsonl = trace.interactions.map((i) => JSON.stringify(i)).join('\n');
    zip.file('interactions.jsonl', interactionsJsonl);

    // Add snapshots - include both HTML and full JSON data
    const snapshotsFolder = zip.folder('snapshots');
    const snapshotsDataFolder = zip.folder('snapshots-data');

    // Create a manifest mapping snapshot IDs to their files
    const snapshotManifest: Record<string, { htmlFile: string; dataFile: string }> = {};

    for (const snapshot of snapshots) {
      // HTML for viewing
      const htmlFile = `snapshots/${snapshot.id}.html`;
      snapshotsFolder?.file(`${snapshot.id}.html`, snapshot.html);

      // Full snapshot data (with annotations, questions, etc.)
      const dataFile = `snapshots-data/${snapshot.id}.json`;
      snapshotsDataFolder?.file(`${snapshot.id}.json`, JSON.stringify(snapshot, null, 2));

      snapshotManifest[snapshot.id] = { htmlFile, dataFile };
    }

    // Add manifest file for easy import
    zip.file('snapshots-manifest.json', JSON.stringify(snapshotManifest, null, 2));

    // Generate ZIP blob
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `trace-${traceId.substring(0, 8)}-${new Date().toISOString().split('T')[0]}.zip`;
    a.click();

    URL.revokeObjectURL(url);
    showStatus(`Exported trace with ${snapshots.length} snapshots`, 'success');
  } catch (error) {
    showStatus(`Export failed: ${(error as Error).message}`, 'error');
  }
}

// Open trace in viewer
async function openTraceInViewer(traceId: string) {
  const viewerUrl = chrome.runtime.getURL(`viewer.html?traceId=${traceId}`);
  await chrome.tabs.create({ url: viewerUrl });
}
