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

// Capture additional styles that SingleFile might miss
// Focus on: adopted stylesheets and shadow DOM styles
// Note: We don't capture link stylesheet rules as SingleFile already handles those
function captureAdditionalStyles(): string[] {
  const additionalStyles: string[] = [];

  // 1. Capture adopted stylesheets from document
  // These are CSSStyleSheet objects created via new CSSStyleSheet() and added to
  // document.adoptedStyleSheets - commonly used by CSS-in-JS libraries and web components
  if (document.adoptedStyleSheets?.length) {
    console.log(`refine.page: Found ${document.adoptedStyleSheets.length} adopted stylesheets on document`);
    document.adoptedStyleSheets.forEach((sheet, i) => {
      try {
        const rules = Array.from(sheet.cssRules);
        if (rules.length > 0) {
          const css = rules.map(r => r.cssText).join('\n');
          additionalStyles.push(`/* Adopted stylesheet ${i} */\n${css}`);
          console.log(`refine.page: Captured adopted stylesheet ${i} with ${rules.length} rules`);
        }
      } catch (e) {
        console.log(`refine.page: Could not capture adopted stylesheet ${i}: ${e}`);
      }
    });
  }

  // 2. Capture styles from shadow DOM
  // Shadow DOM styles are encapsulated and SingleFile may not capture them properly
  const capturedShadowStyles = new Set<string>();
  let shadowHostsFound = 0;

  function captureShadowStyles(root: Document | ShadowRoot): void {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        shadowHostsFound++;

        // Capture adopted stylesheets from shadow root
        if (el.shadowRoot.adoptedStyleSheets?.length) {
          el.shadowRoot.adoptedStyleSheets.forEach((sheet, i) => {
            try {
              const rules = Array.from(sheet.cssRules);
              if (rules.length > 0) {
                const css = rules.map(r => r.cssText).join('\n');
                if (!capturedShadowStyles.has(css)) {
                  capturedShadowStyles.add(css);
                  additionalStyles.push(`/* Shadow DOM adopted stylesheet */\n${css}`);
                  console.log(`refine.page: Captured shadow DOM adopted stylesheet with ${rules.length} rules`);
                }
              }
            } catch (e) {
              // Ignore errors
            }
          });
        }

        // Capture style elements in shadow root
        el.shadowRoot.querySelectorAll('style').forEach((style) => {
          const css = style.textContent?.trim();
          if (css && !capturedShadowStyles.has(css)) {
            capturedShadowStyles.add(css);
            additionalStyles.push(`/* Shadow DOM style element */\n${css}`);
            console.log(`refine.page: Captured shadow DOM style element`);
          }
        });

        // Recurse into nested shadow roots
        captureShadowStyles(el.shadowRoot);
      }
    });
  }
  captureShadowStyles(document);

  if (shadowHostsFound > 0) {
    console.log(`refine.page: Found ${shadowHostsFound} shadow DOM hosts, captured ${capturedShadowStyles.size} unique shadow styles`);
  }

  // 3. Capture CSS custom properties set on :root/html/body via JavaScript
  // These might not be captured if they were set via element.style.setProperty()
  const capturedVars: string[] = [];

  // Check html element for custom properties
  const htmlStyle = document.documentElement.getAttribute('style');
  if (htmlStyle && htmlStyle.includes('--')) {
    capturedVars.push(`html { ${htmlStyle} }`);
    console.log('refine.page: Captured custom properties from html style attribute');
  }

  // Check body element for custom properties
  const bodyStyle = document.body?.getAttribute('style');
  if (bodyStyle && bodyStyle.includes('--')) {
    capturedVars.push(`body { ${bodyStyle} }`);
    console.log('refine.page: Captured custom properties from body style attribute');
  }

  if (capturedVars.length > 0) {
    additionalStyles.push(`/* CSS custom properties from inline styles */\n${capturedVars.join('\n')}`);
  }

  return additionalStyles;
}

// Make snapshot inert - disable all interactive elements
function makeInert(html: string, additionalStyles: string[] = []): string {
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

  // Inject additional captured styles that SingleFile might have missed
  if (additionalStyles.length > 0) {
    const additionalStyleElement = doc.createElement('style');
    additionalStyleElement.setAttribute('data-refine-page-additional-styles', 'true');
    additionalStyleElement.textContent = additionalStyles.join('\n\n');
    // Insert at the end of head to ensure these styles take precedence
    doc.head?.appendChild(additionalStyleElement);
    console.log(`refine.page: Injected ${additionalStyles.length} additional style blocks`);
  }

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

// Debug: Collect style information before capture
function debugStyleInfo(): void {
  console.log('refine.page: === STYLE DEBUG INFO ===');

  // Check adopted stylesheets
  const adoptedSheets = document.adoptedStyleSheets;
  console.log(`refine.page: Adopted stylesheets count: ${adoptedSheets?.length ?? 0}`);
  if (adoptedSheets?.length) {
    adoptedSheets.forEach((sheet, i) => {
      try {
        const rules = Array.from(sheet.cssRules);
        console.log(`refine.page: Adopted sheet ${i}: ${rules.length} rules`);
        if (rules.length > 0) {
          console.log(`refine.page: First rule: ${rules[0].cssText.substring(0, 100)}...`);
        }
      } catch (e) {
        console.log(`refine.page: Adopted sheet ${i}: Cannot access rules (${e})`);
      }
    });
  }

  // Check all style elements
  const styleElements = document.querySelectorAll('style');
  console.log(`refine.page: <style> elements count: ${styleElements.length}`);

  // Check link stylesheets
  const linkElements = document.querySelectorAll('link[rel*="stylesheet"]');
  console.log(`refine.page: <link rel="stylesheet"> elements count: ${linkElements.length}`);
  linkElements.forEach((link, i) => {
    const href = link.getAttribute('href');
    console.log(`refine.page: Link ${i}: ${href?.substring(0, 80)}`);

    // Check if the stylesheet has been modified at runtime
    const linkEl = link as HTMLLinkElement;
    try {
      if (linkEl.sheet?.cssRules) {
        console.log(`refine.page: Link ${i} has ${linkEl.sheet.cssRules.length} live rules`);
      }
    } catch (e) {
      console.log(`refine.page: Link ${i}: Cannot access rules (cross-origin?)`);
    }
  });

  // Check for shadow DOM hosts
  const allElements = document.querySelectorAll('*');
  let shadowHostCount = 0;
  allElements.forEach(el => {
    if (el.shadowRoot) shadowHostCount++;
  });
  console.log(`refine.page: Shadow DOM hosts count: ${shadowHostCount}`);

  console.log('refine.page: === END STYLE DEBUG INFO ===');
}

// Main capture function using SingleFile
export async function capturePage(): Promise<Snapshot> {
  console.log('refine.page: Starting capture of', window.location.href);
  const startTime = Date.now();

  // Debug: Log style information before capture
  debugStyleInfo();

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

  // Capture additional styles that SingleFile might have missed
  // This must be done BEFORE we process pageData.content, as it reads from the live DOM
  const additionalStyles = captureAdditionalStyles();
  console.log(`refine.page: Captured ${additionalStyles.length} additional style sources`);

  // Make the snapshot inert
  const inertHtml = makeInert(pageData.content, additionalStyles);

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
