/**
 * Content script for capturing page snapshots using SingleFile
 * Produces high-fidelity single HTML file snapshots
 */

import type { Snapshot, CaptureCompleteMessage, CaptureErrorMessage } from '@/types';

// SingleFile configuration options
const SINGLE_FILE_OPTIONS = {
  removeHiddenElements: false,
  removeUnusedStyles: true,
  removeUnusedFonts: true,
  removeFrames: false,
  removeImports: true,
  removeScripts: true,
  compressHTML: false,
  compressCSS: false,
  loadDeferredImages: true,
  loadDeferredImagesMaxIdleTime: 1500,
  loadDeferredImagesBlockCookies: false,
  loadDeferredImagesBlockStorage: false,
  loadDeferredImagesKeepZoomLevel: false,
  filenameTemplate: '{page-title}',
  infobarTemplate: '',
  includeInfobar: false,
  confirmInfobarContent: false,
  autoClose: false,
  confirmFilename: false,
  filenameConflictAction: 'uniquify',
  filenameMaxLength: 192,
  filenameMaxLengthUnit: 'bytes',
  filenameReplacedCharacters: ['~', '+', '\\\\', '?', '%', '*', ':', '|', '"', '<', '>', '\x00-\x1f', '\x7F'],
  filenameReplacementCharacter: '_',
  contextMenuEnabled: true,
  tabMenuEnabled: true,
  browserActionMenuEnabled: true,
  shadowEnabled: true,
  logsEnabled: true,
  progressBarEnabled: true,
  maxResourceSizeEnabled: false,
  maxResourceSize: 10,
  displayInfobar: true,
  displayStats: false,
  backgroundSave: true,
  autoSaveDelay: 1,
  autoSaveLoad: false,
  autoSaveUnload: false,
  autoSaveLoadOrUnload: false,
  autoSaveDiscard: false,
  autoSaveRemove: false,
  autoSaveRepeat: false,
  autoSaveRepeatDelay: 10,
  removeAlternativeFonts: true,
  removeAlternativeMedias: true,
  removeAlternativeImages: true,
  groupDuplicateImages: true,
  saveRawPage: false,
  saveToClipboard: false,
  addProof: false,
  saveToGDrive: false,
  saveToDropbox: false,
  saveWithWebDAV: false,
  webDAVURL: '',
  webDAVUser: '',
  webDAVPassword: '',
  saveToGitHub: false,
  githubToken: '',
  githubUser: '',
  githubRepository: 'SingleFile-Archives',
  githubBranch: 'main',
  saveWithCompanion: false,
  forceWebAuthFlow: false,
  resolveFragmentIdentifierURLs: false,
  userScriptEnabled: false,
  openEditor: false,
  openSavedPage: false,
  autoOpenEditor: false,
  saveCreatedBookmarks: false,
  allowedBookmarkFolders: [],
  ignoredBookmarkFolders: [],
  replaceBookmarkURL: true,
  saveFavicon: true,
  includeBOM: false,
  warnUnsavedPage: true,
  autoSaveExternalSave: false,
  insertMetaNoIndex: false,
  insertMetaCSP: true,
  passReferrerOnError: false,
  insertSingleFileComment: true,
  blockMixedContent: false,
  saveOriginalURLs: false,
  acceptHeaders: {
    font: 'application/font-woff2;q=1.0,application/font-woff;q=0.9,*/*;q=0.8',
    image: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    stylesheet: 'text/css,*/*;q=0.1',
    script: '*/*',
    document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  moveStylesInHead: false,
  networkTimeout: 0,
  woleetKey: '',
  blockImages: false,
  blockStylesheets: false,
  blockFonts: false,
  blockScripts: true,
  blockVideos: true,
  blockAudios: true,
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

  // Disable all links by removing href and adding data attribute
  doc.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href) {
      link.setAttribute('data-original-href', href);
      link.removeAttribute('href');
      link.setAttribute('style', (link.getAttribute('style') || '') + ';cursor:default;pointer-events:none;');
    }
  });

  // Disable all forms
  doc.querySelectorAll('form').forEach((form) => {
    form.setAttribute('onsubmit', 'return false;');
    form.setAttribute('action', 'javascript:void(0);');
  });

  // Disable all buttons
  doc.querySelectorAll('button').forEach((btn) => {
    btn.setAttribute('disabled', 'disabled');
  });

  // Disable all inputs
  doc.querySelectorAll('input, select, textarea').forEach((input) => {
    input.setAttribute('disabled', 'disabled');
  });

  // Add meta tag to identify as snapshot
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'page-labeller-snapshot');
  meta.setAttribute('content', 'true');
  doc.head?.appendChild(meta);

  // Add CSP meta tag to block any remaining scripts
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', "script-src 'none'; frame-src 'none';");
  doc.head?.insertBefore(cspMeta, doc.head.firstChild);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// Capture the current page using SingleFile
async function captureWithSingleFile(): Promise<string> {
  // SingleFile is injected by the build process
  // We need to use the global SingleFile object if available
  const win = window as Window & { singlefile?: { getPageData: (options: unknown) => Promise<{ content: string }> } };

  if (win.singlefile) {
    const pageData = await win.singlefile.getPageData(SINGLE_FILE_OPTIONS);
    return pageData.content;
  }

  // Fallback: Use simpler capture method if SingleFile not loaded
  return captureSimple();
}

// Simple capture fallback (used when SingleFile isn't available)
async function captureSimple(): Promise<string> {
  const doc = document.cloneNode(true) as Document;

  // Remove scripts
  doc.querySelectorAll('script').forEach((script) => script.remove());

  // Inline stylesheets
  const styles: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      if (sheet.cssRules) {
        for (const rule of sheet.cssRules) {
          styles.push(rule.cssText);
        }
      }
    } catch {
      // Cross-origin stylesheet - try to fetch
      if (sheet.href) {
        try {
          const response = await fetch(sheet.href);
          const css = await response.text();
          styles.push(css);
        } catch {
          console.warn('Could not fetch stylesheet:', sheet.href);
        }
      }
    }
  }

  // Add consolidated styles
  const styleEl = doc.createElement('style');
  styleEl.textContent = styles.join('\n');
  doc.head?.appendChild(styleEl);

  // Convert images to data URLs
  const images = doc.querySelectorAll('img');
  for (const img of images) {
    if (img.src && !img.src.startsWith('data:')) {
      try {
        const response = await fetch(img.src);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        img.src = dataUrl;
      } catch {
        console.warn('Failed to convert image:', img.src);
      }
    }
  }

  // Add base URL
  let baseEl = doc.querySelector('base');
  if (!baseEl) {
    baseEl = doc.createElement('base');
    doc.head?.insertBefore(baseEl, doc.head.firstChild);
  }
  baseEl.href = window.location.href;

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

// Main capture function
export async function capturePage(): Promise<Snapshot> {
  console.log('Page Labeller: Starting capture...');

  let html: string;
  try {
    html = await captureWithSingleFile();
  } catch (error) {
    console.warn('SingleFile capture failed, using fallback:', error);
    html = await captureSimple();
  }

  // Make the snapshot inert
  const inertHtml = makeInert(html);

  const snapshot: Snapshot = {
    id: generateId(),
    url: window.location.href,
    title: document.title,
    html: inertHtml,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    annotations: {
      text: [],
      region: [],
    },
    questions: [],
    status: 'pending',
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
  };

  console.log('Page Labeller: Capture complete, snapshot size:', inertHtml.length);
  return snapshot;
}

// Listen for capture messages from the popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    capturePage()
      .then((snapshot) => {
        // Store the snapshot
        chrome.storage.local.set({ [`snapshot_${snapshot.id}`]: snapshot }, () => {
          if (chrome.runtime.lastError) {
            const response: CaptureErrorMessage = {
              type: 'CAPTURE_ERROR',
              payload: { error: chrome.runtime.lastError.message || 'Storage error' },
            };
            sendResponse(response);
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

          const response: CaptureCompleteMessage = {
            type: 'CAPTURE_COMPLETE',
            payload: { snapshotId: snapshot.id },
          };
          sendResponse(response);
        });
      })
      .catch((error) => {
        console.error('Page Labeller: Capture error:', error);
        const response: CaptureErrorMessage = {
          type: 'CAPTURE_ERROR',
          payload: { error: error.message || 'Unknown error' },
        };
        sendResponse(response);
      });

    // Return true to indicate async response
    return true;
  }
});

console.log('Page Labeller: Content script loaded');
