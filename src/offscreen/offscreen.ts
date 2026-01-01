/**
 * Offscreen document for refine.page extension
 * Handles MHTML to HTML conversion using DOM APIs not available in service workers
 */

import mhtml2html from 'mhtml2html';

// Make HTML inert - disable all interactive elements
function makeInert(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all scripts
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

  // Add strict CSP meta tag - allow inline styles since MHTML inlines everything
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

// Convert MHTML to inert HTML
function convertMhtmlToHtml(mhtmlText: string): { html: string; title: string } {
  console.log('refine.page offscreen: Converting MHTML to HTML...');
  const startTime = Date.now();

  // Convert MHTML to HTML document using mhtml2html
  const htmlDoc = mhtml2html.convert(mhtmlText);

  // Get the HTML string from the document
  const htmlString = '<!DOCTYPE html>\n' + htmlDoc.documentElement.outerHTML;
  const title = htmlDoc.title || 'Untitled';

  // Make the HTML inert
  const inertHtml = makeInert(htmlString);

  const duration = Date.now() - startTime;
  console.log(`refine.page offscreen: Conversion complete in ${duration}ms, HTML size: ${(inertHtml.length / 1024).toFixed(1)}KB`);

  return { html: inertHtml, title };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CONVERT_MHTML') {
    try {
      const result = convertMhtmlToHtml(message.payload.mhtmlText);
      sendResponse({ type: 'CONVERT_MHTML_COMPLETE', payload: result });
    } catch (error) {
      console.error('refine.page offscreen: Conversion error:', error);
      sendResponse({ type: 'CONVERT_MHTML_ERROR', payload: { error: (error as Error).message } });
    }
    return true;
  }
});

console.log('refine.page: Offscreen document loaded');
