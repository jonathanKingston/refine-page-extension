/**
 * Offscreen document for refine.page extension
 * Handles MHTML to HTML conversion using DOM APIs not available in service workers
 */

import * as mhtml2html from 'mhtml2html';

// Remove non-inlined resource URLs from CSS to prevent failed loads
// Keeps data: and blob: URLs, removes everything else
function cleanCssUrls(css: string): string {
  // Match url(...) but keep data: and blob: URLs
  // Replace with empty url() to avoid CORS errors with about:blank
  return css.replace(/url\s*\(\s*(['"]?)(?!data:|blob:)([^)'"]+)\1\s*\)/gi, 'url()');
}

// Clean all stylesheets and inline styles in the document
function cleanResourceUrls(doc: Document): void {
  // Clean <style> elements
  const styleElements = doc.querySelectorAll('style');
  for (let i = 0; i < styleElements.length; i++) {
    const style = styleElements[i];
    if (style.textContent) {
      style.textContent = cleanCssUrls(style.textContent);
    }
  }

  // Clean inline style attributes and other elements in a single pass
  // Use a walker to process all elements efficiently
  const walker = doc.createTreeWalker(
    doc.body || doc.documentElement,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const el = node as Element;
    const tagName = el.tagName.toLowerCase();

    // Clean inline style attributes
    const styleAttr = el.getAttribute('style');
    if (styleAttr) {
      el.setAttribute('style', cleanCssUrls(styleAttr));
    }

    // Clean <link> stylesheets that aren't data URLs
    if (tagName === 'link' && el.getAttribute('rel') === 'stylesheet') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('data:')) {
        el.remove();
      }
    }

    // Clean img src that aren't data URLs
    if (tagName === 'img') {
      const src = el.getAttribute('src');
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        // Keep the element but use a transparent placeholder
        el.setAttribute('data-original-src', src);
        el.setAttribute(
          'src',
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
        );
      }
    }
  }
}

// Make HTML inert - disable all interactive elements
function makeInert(html: string, baseUrl?: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Set base URL if provided and not already present
  if (baseUrl) {
    let baseEl = doc.querySelector('base');
    if (!baseEl) {
      baseEl = doc.createElement('base');
      doc.head?.insertBefore(baseEl, doc.head.firstChild);
    }
    baseEl.setAttribute('href', baseUrl);
  }

  // Clean up non-inlined resource URLs first
  cleanResourceUrls(doc);

  // Remove all scripts and noscripts in one pass
  const scriptsAndNoscripts = doc.querySelectorAll('script, noscript');
  scriptsAndNoscripts.forEach((el) => el.remove());

  // Process all interactive elements in a single traversal
  const eventAttrs = [
    'onclick',
    'onmouseover',
    'onmouseout',
    'onload',
    'onerror',
    'onsubmit',
    'onchange',
    'onfocus',
    'onblur',
  ];

  // Use a single walker to process all elements efficiently
  const walker = doc.createTreeWalker(
    doc.body || doc.documentElement,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  const elementsToProcess: Element[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    elementsToProcess.push(node as Element);
  }

  // Process all elements in batch
  for (const el of elementsToProcess) {
    const tagName = el.tagName.toLowerCase();

    // Remove event handler attributes
    for (const attr of eventAttrs) {
      el.removeAttribute(attr);
    }

    // Handle specific element types
    if (tagName === 'a') {
      const href = el.getAttribute('href');
      if (href) {
        el.setAttribute('data-original-href', href);
        el.removeAttribute('href');
      }
    } else if (tagName === 'form') {
      el.removeAttribute('action');
    } else if (['button', 'input', 'select', 'textarea'].includes(tagName)) {
      el.setAttribute('disabled', 'disabled');
    }
  }

  // Add meta tag to identify as refine.page snapshot
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'refine-page-snapshot');
  meta.setAttribute('content', 'true');
  meta.setAttribute('data-captured-at', new Date().toISOString());
  doc.head?.appendChild(meta);

  // Add strict CSP meta tag - allow inline styles since MHTML inlines everything
  const cspMeta = doc.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute(
    'content',
    "default-src 'self' data: blob:; script-src 'none'; style-src 'unsafe-inline' data: blob:; font-src data: blob:; img-src 'self' data: blob:; frame-src 'none'; object-src 'none';"
  );
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

// Convert MHTML to inert HTML
function convertMhtmlToHtml(mhtmlText: string, baseUrl?: string): { html: string; title: string } {
  console.log('refine.page offscreen: Converting MHTML to HTML...');
  console.log('refine.page offscreen: MHTML size:', mhtmlText.length, 'chars');
  const startTime = Date.now();

  // Get the convert function - handle both default and named exports
  const convertFn =
    (mhtml2html as any).default?.convert || (mhtml2html as any).convert || mhtml2html.convert;

  if (!convertFn) {
    throw new Error('mhtml2html.convert function not found');
  }

  // Convert MHTML to HTML - mhtml2html returns {window: {document: Document}}
  const result = convertFn(mhtmlText);

  // Extract the actual document from the result
  const doc = result?.window?.document;

  if (!doc || !doc.documentElement) {
    console.error('refine.page offscreen: conversion result:', result);
    throw new Error(`mhtml2html conversion failed - no document returned`);
  }

  // Get the HTML string from the document
  const htmlString = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  const title = doc.title || 'Untitled';

  // Make the HTML inert
  const inertHtml = makeInert(htmlString, baseUrl);

  const duration = Date.now() - startTime;
  console.log(
    `refine.page offscreen: Conversion complete in ${duration}ms, HTML size: ${(inertHtml.length / 1024).toFixed(1)}KB`
  );

  return { html: inertHtml, title };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CONVERT_MHTML') {
    try {
      const result = convertMhtmlToHtml(message.payload.mhtmlText, message.payload.baseUrl);
      sendResponse({ type: 'CONVERT_MHTML_COMPLETE', payload: result });
    } catch (error) {
      console.error('refine.page offscreen: Conversion error:', error);
      sendResponse({ type: 'CONVERT_MHTML_ERROR', payload: { error: (error as Error).message } });
    }
    return true;
  }
});

console.log('refine.page: Offscreen document loaded');

// Signal to background script that we're ready
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
  // Background might not be listening yet, which is fine
});
