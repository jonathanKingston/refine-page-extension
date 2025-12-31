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
  removeUnusedStyles: true,
  removeUnusedFonts: true,
  removeFrames: false,
  removeImports: true,
  removeScripts: true,       // Remove scripts for inert snapshot
  removeAlternativeFonts: true,
  removeAlternativeMedias: true,
  removeAlternativeImages: true,
  groupDuplicateImages: true,

  // Image handling - DISABLED to prevent hanging on lazy images
  loadDeferredImages: false,
  loadDeferredImagesMaxIdleTime: 500,
  loadDeferredImagesBlockCookies: true,
  loadDeferredImagesBlockStorage: true,
  loadDeferredImagesKeepZoomLevel: false,

  // Compression/Output
  compressHTML: false,
  compressCSS: false,
  compressContent: false,

  // Metadata
  saveFavicon: true,
  insertMetaNoIndex: false,
  insertMetaCSP: true,        // Add CSP to block scripts
  insertSingleFileComment: true,
  insertCanonicalLink: true,

  // Content blocking for clean capture
  blockImages: false,
  blockStylesheets: false,
  blockFonts: false,
  blockScripts: true,
  blockVideos: true,          // Don't include videos
  blockAudios: true,          // Don't include audio
  blockMixedContent: false,

  // Other options
  saveRawPage: false,
  saveOriginalURLs: false,
  networkTimeout: 10000,      // 10 second timeout for resources
  maxResourceSizeEnabled: false,
};

// Initialize SingleFile with fetch implementation
const INIT_OPTIONS = {
  fetch: async (url: string, options?: RequestInit) => {
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'omit',
        mode: 'cors',
      });
      return response;
    } catch (error) {
      console.warn('SingleFile fetch failed for:', url, error);
      throw error;
    }
  },
  frameFetch: async (url: string, options?: RequestInit) => {
    try {
      const response = await fetch(url, {
        ...options,
        credentials: 'omit',
        mode: 'cors',
      });
      return response;
    } catch (error) {
      console.warn('SingleFile frame fetch failed for:', url, error);
      throw error;
    }
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

  // Remove noscript tags too
  doc.querySelectorAll('noscript').forEach((el) => el.remove());

  // Disable all links by removing href and adding data attribute
  doc.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href) {
      link.setAttribute('data-original-href', href);
      link.removeAttribute('href');
      link.setAttribute('role', 'link');
      link.setAttribute('tabindex', '0');
      // Add inline styles to show it's inactive
      const existingStyle = link.getAttribute('style') || '';
      link.setAttribute('style', existingStyle + ';cursor:default;pointer-events:none;');
    }
  });

  // Disable all forms
  doc.querySelectorAll('form').forEach((form) => {
    form.setAttribute('data-original-action', form.getAttribute('action') || '');
    form.removeAttribute('action');
    form.setAttribute('onsubmit', 'return false;');
  });

  // Disable all buttons
  doc.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach((btn) => {
    btn.setAttribute('disabled', 'disabled');
  });

  // Disable all form inputs
  doc.querySelectorAll('input, select, textarea').forEach((input) => {
    input.setAttribute('disabled', 'disabled');
  });

  // Remove event handler attributes
  const eventAttrs = ['onclick', 'onmouseover', 'onmouseout', 'onload', 'onerror', 'onsubmit', 'onchange', 'onfocus', 'onblur'];
  doc.querySelectorAll('*').forEach((el) => {
    eventAttrs.forEach((attr) => el.removeAttribute(attr));
  });

  // Add meta tag to identify as Page Labeller snapshot
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'page-labeller-snapshot');
  meta.setAttribute('content', 'true');
  meta.setAttribute('data-captured-at', new Date().toISOString());
  doc.head?.appendChild(meta);

  // Add strict CSP meta tag to block any remaining scripts or frames
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', "default-src 'self' data: blob:; script-src 'none'; frame-src 'none'; object-src 'none';");
  doc.head?.insertBefore(cspMeta, doc.head.firstChild);

  // Add a style to ensure links look inactive
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
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// Capture the current page using SingleFile
async function captureWithSingleFile(): Promise<string> {
  console.log('Page Labeller: Using SingleFile for capture...');

  try {
    // Initialize SingleFile
    singlefile.init(INIT_OPTIONS);

    // Get page data using SingleFile with 15 second timeout
    const pageData = await withTimeout(
      singlefile.getPageData(
        SINGLE_FILE_OPTIONS,
        INIT_OPTIONS,
        document,
        window
      ),
      15000,
      'SingleFile capture timed out after 15 seconds'
    );

    if (!pageData || !pageData.content) {
      throw new Error('SingleFile returned empty content');
    }

    console.log('Page Labeller: SingleFile capture successful, size:', pageData.content.length);
    return pageData.content;
  } catch (error) {
    console.error('Page Labeller: SingleFile capture failed:', error);
    throw error;
  }
}

// Simple capture fallback (used when SingleFile fails)
async function captureSimple(): Promise<string> {
  console.log('Page Labeller: Using simple capture fallback...');

  // Clone the document
  const docClone = document.cloneNode(true) as Document;

  // Remove scripts
  docClone.querySelectorAll('script').forEach((script) => script.remove());

  // Remove iframes (they won't work in snapshot anyway)
  docClone.querySelectorAll('iframe').forEach((iframe) => iframe.remove());

  // Inline all stylesheets
  const styles: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      if (sheet.cssRules) {
        for (const rule of sheet.cssRules) {
          styles.push(rule.cssText);
        }
      }
    } catch {
      // Cross-origin stylesheet - try to fetch it
      if (sheet.href) {
        try {
          const response = await fetch(sheet.href, { mode: 'cors', credentials: 'omit' });
          const css = await response.text();
          styles.push(`/* From: ${sheet.href} */\n${css}`);
        } catch {
          console.warn('Could not fetch stylesheet:', sheet.href);
        }
      }
    }
  }

  // Remove external stylesheet links and add inlined styles
  docClone.querySelectorAll('link[rel="stylesheet"]').forEach((link) => link.remove());
  const styleEl = docClone.createElement('style');
  styleEl.textContent = styles.join('\n');
  docClone.head?.appendChild(styleEl);

  // Convert images to data URLs
  const images = docClone.querySelectorAll('img');
  for (const img of images) {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:')) {
      try {
        // Get the actual rendered src (handles srcset, lazy loading)
        const actualSrc = (document.querySelector(`img[src="${src}"]`) as HTMLImageElement)?.currentSrc || src;
        const response = await fetch(actualSrc, { mode: 'cors', credentials: 'omit' });
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
        img.removeAttribute('srcset');
        img.removeAttribute('data-src');
        img.removeAttribute('loading');
      } catch {
        console.warn('Failed to convert image:', src);
      }
    }
  }

  // Handle background images in inline styles
  docClone.querySelectorAll('[style*="url("]').forEach(async (el) => {
    const style = el.getAttribute('style') || '';
    const urlMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:')) {
      try {
        const response = await fetch(urlMatch[1], { mode: 'cors', credentials: 'omit' });
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        el.setAttribute('style', style.replace(urlMatch[0], `url(${dataUrl})`));
      } catch {
        // Keep original URL if fetch fails
      }
    }
  });

  // Add base URL for any remaining relative URLs
  let baseEl = docClone.querySelector('base');
  if (!baseEl) {
    baseEl = docClone.createElement('base');
    docClone.head?.insertBefore(baseEl, docClone.head.firstChild);
  }
  baseEl.setAttribute('href', window.location.href);

  return '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
}

// Main capture function
export async function capturePage(): Promise<Snapshot> {
  console.log('Page Labeller: Starting capture of', window.location.href);
  const startTime = Date.now();

  let html: string;
  let captureMethod: string;

  try {
    html = await captureWithSingleFile();
    captureMethod = 'singlefile';
  } catch (error) {
    console.warn('Page Labeller: SingleFile capture failed, using fallback:', error);
    html = await captureSimple();
    captureMethod = 'simple';
  }

  // Make the snapshot inert (disable all interactive elements)
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

  const duration = Date.now() - startTime;
  console.log(`Page Labeller: Capture complete (${captureMethod}) in ${duration}ms, size: ${(inertHtml.length / 1024).toFixed(1)}KB`);

  return snapshot;
}

// Listen for capture messages from the popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_PAGE') {
    capturePage()
      .then((snapshot) => {
        // Store the snapshot using chrome.storage.local
        chrome.storage.local.set({ [`snapshot_${snapshot.id}`]: snapshot }, () => {
          if (chrome.runtime.lastError) {
            const response: CaptureErrorMessage = {
              type: 'CAPTURE_ERROR',
              payload: { error: chrome.runtime.lastError.message || 'Storage error' },
            };
            sendResponse(response);
            return;
          }

          // Update the snapshot index
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
