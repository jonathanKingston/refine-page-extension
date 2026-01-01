/**
 * Snapshot viewer - serves snapshots as self-contained pages
 */

import type { Snapshot } from '@/types';

// Get URL parameters
function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
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

// Load and display snapshot
async function loadSnapshot(snapshotId: string) {
  const iframe = document.getElementById('snapshot-frame') as HTMLIFrameElement;
  const titleEl = document.getElementById('snapshot-title');
  const urlEl = document.getElementById('snapshot-url');

  try {
    const snapshot = await sendMessage<Snapshot>('GET_SNAPSHOT', { id: snapshotId });

    if (!snapshot) {
      showError('Snapshot not found');
      return;
    }

    // Update UI
    if (titleEl) titleEl.textContent = snapshot.title || 'Untitled';
    if (urlEl) urlEl.textContent = snapshot.url;
    document.title = `${snapshot.title || 'Snapshot'} - refine.page`;

    // Load HTML into iframe using srcdoc for better isolation
    // We use a blob URL to serve the HTML as a proper page
    const blob = new Blob([snapshot.html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    iframe.src = blobUrl;

    // Set up download button
    const downloadBtn = document.getElementById('download-btn');
    downloadBtn?.addEventListener('click', () => {
      downloadSnapshot(snapshot);
    });

    // Set up labeller button
    const labellerBtn = document.getElementById('open-labeller');
    labellerBtn?.addEventListener('click', () => {
      const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${snapshotId}`);
      chrome.tabs.create({ url: viewerUrl });
    });

  } catch (error) {
    console.error('Failed to load snapshot:', error);
    showError((error as Error).message);
  }
}

// Download snapshot as HTML file
function downloadSnapshot(snapshot: Snapshot) {
  const blob = new Blob([snapshot.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(snapshot.title || 'snapshot')}.html`;
  a.click();

  URL.revokeObjectURL(url);
}

// Sanitize filename
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9\-_]/gi, '_').substring(0, 100);
}

// Show error
function showError(message: string) {
  const container = document.querySelector('.snapshot-frame-container');
  if (container) {
    container.innerHTML = `
      <div class="error">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>${message}</p>
      </div>
    `;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const params = getUrlParams();
  const snapshotId = params.get('id');

  if (!snapshotId) {
    showError('No snapshot ID provided');
    return;
  }

  loadSnapshot(snapshotId);
});
