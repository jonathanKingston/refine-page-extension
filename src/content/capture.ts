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

  // Normalize async CSS patterns into a "final applied" state.
  // Many pages load styles via:
  // - <link rel="stylesheet" media="print" onload="this.media='all'">
  // - <link rel="preload" as="style" onload="this.rel='stylesheet'">
  // We remove inline event handlers below for safety, so we must apply the end-state here
  // or styles will be missing in the snapshot.
  doc.querySelectorAll('link').forEach((link) => {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const relTokens = new Set(rel.split(/\s+/).filter(Boolean));
    const as = (link.getAttribute('as') || '').toLowerCase();
    const hadOnload = link.hasAttribute('onload');

    // Convert style preloads into real stylesheets.
    // We only do this when the page intended to activate the preload via onload.
    if (hadOnload && relTokens.has('preload') && as === 'style') {
      link.setAttribute('rel', 'stylesheet');
      link.removeAttribute('as');
    }

    // Ensure async "print media" stylesheets are actually applied.
    const media = (link.getAttribute('media') || '').toLowerCase();
    // Only flip when it's the common async-load trick (print -> all via onload).
    if (hadOnload && media === 'print') {
      link.setAttribute('media', 'all');
    }

    // If a stylesheet was intended to be enabled by JS, make it enabled.
    if (hadOnload && link.hasAttribute('disabled')) {
      link.removeAttribute('disabled');
    }

    // Remove inline JS handlers (we do a global sweep below too, but do it here
    // so we never depend on these handlers for CSS activation).
    link.removeAttribute('onload');
    link.removeAttribute('onerror');
  });

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

  // Make interactive elements non-interactive without changing their styling.
  // Using `disabled` can affect rendering on some sites (e.g., inputs can appear hidden or
  // lose critical styles). We instead prevent interaction via CSS (see inert styles below)
  // and a few attributes that don't generally alter appearance.
  doc.querySelectorAll('input, textarea').forEach((el) => {
    // Avoid editing/keyboard focus but keep visuals.
    el.setAttribute('readonly', 'readonly');
    el.setAttribute('tabindex', '-1');
  });
  doc.querySelectorAll('button, select').forEach((el) => {
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-disabled', 'true');
  });

  // Remove ALL inline event handlers for safety.
  // (e.g., onclick, onload, oninput, etc.)
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
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
    /* Prevent interaction while preserving rendering */
    a, button, input, select, textarea { pointer-events: none !important; }
    button, input, select, textarea { caret-color: transparent !important; }
  `;
  doc.head?.appendChild(inertStyle);

  // Preserve open shadow roots through the parse/serialize roundtrip by emitting
  // Declarative Shadow DOM templates before serialization. Otherwise, content inside
  // shadow roots can be lost when using `outerHTML`.
  //
  // While doing so, apply the same inerting rules inside the template content,
  // since document-level CSS/attribute changes don't affect shadow DOM.
  doc.querySelectorAll('*').forEach((el) => {
    const host = el as Element & { shadowRoot?: ShadowRoot | null };
    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) return;

    const hasDeclarativeTemplate = Array.from(host.children).some(
      (child) => child.tagName === 'TEMPLATE' && child.hasAttribute('shadowrootmode')
    );
    if (hasDeclarativeTemplate) return;

    const template = doc.createElement('template');
    template.setAttribute('shadowrootmode', 'open');
    template.innerHTML = shadowRoot.innerHTML;

    // Sanitize & inert shadow content (template.content is a DocumentFragment).
    template.content.querySelectorAll('script, noscript').forEach((n) => n.remove());
    template.content.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href');
      if (href) {
        link.setAttribute('data-original-href', href);
        link.removeAttribute('href');
      }
    });
    template.content.querySelectorAll('form').forEach((form) => {
      form.removeAttribute('action');
      form.setAttribute('onsubmit', 'return false;');
    });
    template.content.querySelectorAll('input, textarea').forEach((node) => {
      node.setAttribute('readonly', 'readonly');
      node.setAttribute('tabindex', '-1');
    });
    template.content.querySelectorAll('button, select').forEach((node) => {
      node.setAttribute('tabindex', '-1');
      node.setAttribute('aria-disabled', 'true');
    });
    template.content.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name.toLowerCase().startsWith('on')) {
          node.removeAttribute(attr.name);
        }
      }
    });
    const shadowInertStyle = doc.createElement('style');
    shadowInertStyle.textContent = `
      a[data-original-href] { cursor: default !important; pointer-events: none !important; }
      a, button, input, select, textarea { pointer-events: none !important; }
      button, input, select, textarea { caret-color: transparent !important; }
    `;
    template.content.insertBefore(shadowInertStyle, template.content.firstChild);

    host.insertBefore(template, host.firstChild);
  });

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

// Best-effort wait for client-rendered UI to appear (e.g. Next/React hydration).
// Some sites (DuckDuckGo included) render key UI like the search box client-side;
// capturing too early can miss it even though the page is "mostly" loaded.
async function waitForPageToSettle(maxWaitMs: number): Promise<void> {
  const start = Date.now();

  // Wait for load, but don't block forever.
  if (document.readyState !== 'complete') {
    await Promise.race([
      new Promise<void>((resolve) => window.addEventListener('load', () => resolve(), { once: true })),
      new Promise<void>((resolve) => setTimeout(() => resolve(), maxWaitMs)),
    ]);
  }

  // Wait a bit for hydration to render interactive UI.
  while (Date.now() - start < maxWaitMs) {
    if (document.querySelector('input, textarea, select, [role="search"], [role="searchbox"]')) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
  }

  // Allow layout/style flush.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

// Main capture function using SingleFile
export async function capturePage(): Promise<Snapshot> {
  console.log('refine.page: Starting capture of', window.location.href);
  const startTime = Date.now();

  // Give SPAs a moment to finish hydration so we capture the fully rendered DOM.
  await waitForPageToSettle(1500);

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
