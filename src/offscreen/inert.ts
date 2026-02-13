/**
 * HTML inerting and resource cleaning utilities.
 * Extracted from offscreen.ts for testability.
 */

// Remove non-inlined resource URLs from CSS to prevent failed loads
// Keeps data: and blob: URLs, removes everything else
export function cleanCssUrls(css: string): string {
  return css.replace(/url\s*\(\s*(['"]?)(?!data:|blob:)([^)'"]+)\1\s*\)/gi, 'url()');
}

// Clean all stylesheets and inline styles in the document
export function cleanResourceUrls(doc: Document): void {
  // Clean <style> elements
  doc.querySelectorAll('style').forEach((style) => {
    if (style.textContent) {
      style.textContent = cleanCssUrls(style.textContent);
    }
  });

  // Clean inline style attributes
  doc.querySelectorAll('[style]').forEach((el) => {
    const style = el.getAttribute('style');
    if (style) {
      el.setAttribute('style', cleanCssUrls(style));
    }
  });

  // Clean <link> stylesheets that aren't data URLs (they won't work anyway)
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href && !href.startsWith('data:')) {
      link.remove();
    }
  });

  // Clean img src that aren't data URLs
  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
      img.setAttribute('data-original-src', src);
      img.setAttribute(
        'src',
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
      );
    }
  });
}

// Make HTML inert - disable all interactive elements
export function makeInert(html: string, baseUrl?: string): string {
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
  });

  // Disable interactive elements
  doc.querySelectorAll('button, input, select, textarea').forEach((el) => {
    el.setAttribute('disabled', 'disabled');
  });

  // Remove event handler attributes
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
  doc.querySelectorAll('*').forEach((el) => {
    eventAttrs.forEach((attr) => el.removeAttribute(attr));
  });

  // Add meta tag to identify as refine.page snapshot
  const meta = doc.createElement('meta');
  meta.setAttribute('name', 'refine-page-snapshot');
  meta.setAttribute('content', 'true');
  meta.setAttribute('data-captured-at', new Date().toISOString());
  doc.head?.appendChild(meta);

  // Add strict CSP meta tag
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
