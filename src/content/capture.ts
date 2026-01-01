/**
 * Content script for capturing page snapshots using SingleFile
 * Produces high-fidelity single HTML file snapshots
 */

import type { Snapshot, CaptureCompleteMessage, CaptureErrorMessage } from '@/types';
import * as singlefile from 'single-file-core/single-file.js';

// SingleFile configuration options for high-fidelity capture
const SINGLE_FILE_OPTIONS = {
  // Resource handling
  removeHiddenElements: false,
  removeUnusedStyles: false,  // Keep all styles for accurate rendering
  removeUnusedFonts: false,   // Keep all fonts
  removeFrames: true,         // Remove iframes to speed up capture
  removeImports: false,       // Keep CSS imports
  removeScripts: true,
  removeAlternativeFonts: false,
  removeAlternativeMedias: false,
  removeAlternativeImages: false,
  groupDuplicateImages: true,

  // Disable deferred/lazy image loading entirely
  loadDeferredImages: false,

  // Compression/Output
  compressHTML: false,
  compressCSS: false,
  compressContent: false,

  // Metadata
  saveFavicon: true,
  insertMetaNoIndex: false,
  insertMetaCSP: true,
  insertSingleFileComment: true,
  insertCanonicalLink: true,

  // Content blocking
  blockImages: false,
  blockStylesheets: false,
  blockFonts: false,
  blockScripts: true,
  blockVideos: true,
  blockAudios: true,
  blockMixedContent: false,

  // Other options
  saveRawPage: false,
  saveOriginalURLs: false,
  networkTimeout: 5000,  // 5 second timeout for individual resources
  maxResourceSizeEnabled: false,
};

// Initialize SingleFile with fetch implementation
const INIT_OPTIONS = {
  fetch: async (url: string, options?: RequestInit) => {
    const response = await fetch(url, {
      ...options,
      credentials: 'omit',
      mode: 'cors',
    });
    return response;
  },
  frameFetch: async (url: string, options?: RequestInit) => {
    const response = await fetch(url, {
      ...options,
      credentials: 'omit',
      mode: 'cors',
    });
    return response;
  },
};

// Generate unique ID
function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Make snapshot inert - disable all interactive elements
function makeInert(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all scripts (SingleFile should have done this, but ensure)
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

  // Add strict CSP meta tag - allow inline styles since SingleFile inlines everything
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

// Helper to add timeout to a promise
function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), ms);
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((error) => { clearTimeout(timer); reject(error); });
  });
}

// Main capture function using SingleFile
export async function capturePage(): Promise<Snapshot> {
  console.log('refine.page: Starting capture of', window.location.href);
  const startTime = Date.now();

  // Initialize and run SingleFile
  console.log('refine.page: Initializing SingleFile...');
  singlefile.init(INIT_OPTIONS);

  console.log('refine.page: Running SingleFile getPageData...');
  const pageData = await withTimeout(
    singlefile.getPageData(SINGLE_FILE_OPTIONS, INIT_OPTIONS, document, window),
    30000,  // 30 second timeout
    'Capture timed out after 30 seconds'
  );
  console.log('refine.page: SingleFile completed');

  if (!pageData?.content) {
    throw new Error('SingleFile returned empty content');
  }

  // Make the snapshot inert
  const inertHtml = makeInert(pageData.content);

  const snapshot: Snapshot = {
    id: generateId(),
    url: window.location.href,
    title: document.title,
    html: inertHtml,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    annotations: { text: [], region: [] },
    questions: [],
    status: 'pending',
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
  };

  const duration = Date.now() - startTime;
  console.log(`refine.page: Capture complete in ${duration}ms, size: ${(inertHtml.length / 1024).toFixed(1)}KB`);

  return snapshot;
}

// Listen for capture messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    capturePage()
      .then((snapshot) => {
        chrome.storage.local.set({ [`snapshot_${snapshot.id}`]: snapshot }, () => {
          if (chrome.runtime.lastError) {
            sendResponse({ type: 'CAPTURE_ERROR', payload: { error: chrome.runtime.lastError.message || 'Storage error' } });
            return;
          }

          // Update index
          chrome.storage.local.get('snapshotIndex', (result) => {
            const index: string[] = result.snapshotIndex || [];
            if (!index.includes(snapshot.id)) {
              index.push(snapshot.id);
              chrome.storage.local.set({ snapshotIndex: index });
            }
          });

          sendResponse({ type: 'CAPTURE_COMPLETE', payload: { snapshotId: snapshot.id } });
        });
      })
      .catch((error) => {
        console.error('refine.page: Capture error:', error);
        sendResponse({ type: 'CAPTURE_ERROR', payload: { error: error.message || 'Unknown error' } });
      });

    return true; // Async response
  }
});

console.log('refine.page: Content script loaded');
