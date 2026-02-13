/**
 * Tests for offscreen inerting and resource cleaning utilities.
 */

import { describe, it, expect } from 'vitest';
import { cleanCssUrls, cleanResourceUrls, makeInert } from './inert';

describe('cleanCssUrls', () => {
  it('should preserve data: URLs', () => {
    const css = 'background: url(data:image/png;base64,abc);';
    expect(cleanCssUrls(css)).toContain('data:image/png;base64,abc');
  });

  it('should preserve blob: URLs', () => {
    const css = 'background: url(blob:http://example.com/abc);';
    expect(cleanCssUrls(css)).toContain('blob:http://example.com/abc');
  });

  it('should clean external URLs', () => {
    const css = 'background: url(https://example.com/bg.png);';
    expect(cleanCssUrls(css)).not.toContain('https://example.com/bg.png');
    expect(cleanCssUrls(css)).toContain('url()');
  });

  it('should handle quoted URLs', () => {
    const css = "background: url('https://example.com/bg.png');";
    expect(cleanCssUrls(css)).not.toContain('https://example.com');
    expect(cleanCssUrls(css)).toContain('url()');
  });

  it('should handle double-quoted URLs', () => {
    const css = 'background: url("https://example.com/bg.png");';
    expect(cleanCssUrls(css)).not.toContain('https://example.com');
  });

  it('should handle multiple URLs in same CSS', () => {
    const css = 'background: url(https://a.com/1.png); border-image: url(data:image/png;base64,x);';
    const result = cleanCssUrls(css);
    expect(result).not.toContain('https://a.com');
    expect(result).toContain('data:image/png;base64,x');
  });
});

describe('cleanResourceUrls', () => {
  function parseHtml(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  it('should clean style element contents', () => {
    const doc = parseHtml(
      '<html><head><style>body { background: url(https://example.com/bg.png); }</style></head><body></body></html>'
    );
    cleanResourceUrls(doc);
    const style = doc.querySelector('style');
    expect(style?.textContent).not.toContain('https://example.com');
  });

  it('should clean inline style attributes', () => {
    const doc = parseHtml(
      '<html><head></head><body><div style="background: url(https://example.com/bg.png)">test</div></body></html>'
    );
    cleanResourceUrls(doc);
    const div = doc.querySelector('div');
    expect(div?.getAttribute('style')).not.toContain('https://example.com');
  });

  it('should remove non-data stylesheet links', () => {
    const doc = parseHtml(
      '<html><head><link rel="stylesheet" href="https://example.com/style.css"></head><body></body></html>'
    );
    cleanResourceUrls(doc);
    expect(doc.querySelectorAll('link[rel="stylesheet"]').length).toBe(0);
  });

  it('should keep data: stylesheet links', () => {
    const doc = parseHtml(
      '<html><head><link rel="stylesheet" href="data:text/css,body{color:red}"></head><body></body></html>'
    );
    cleanResourceUrls(doc);
    expect(doc.querySelectorAll('link[rel="stylesheet"]').length).toBe(1);
  });

  it('should replace external img src with placeholder', () => {
    const doc = parseHtml(
      '<html><head></head><body><img src="https://example.com/img.png" alt="test"></body></html>'
    );
    cleanResourceUrls(doc);
    const img = doc.querySelector('img');
    expect(img?.getAttribute('data-original-src')).toBe('https://example.com/img.png');
    expect(img?.getAttribute('src')).toContain('data:image/gif;base64');
  });

  it('should keep data: img src', () => {
    const doc = parseHtml(
      '<html><head></head><body><img src="data:image/png;base64,abc"></body></html>'
    );
    cleanResourceUrls(doc);
    const img = doc.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,abc');
    expect(img?.hasAttribute('data-original-src')).toBe(false);
  });

  it('should keep blob: img src', () => {
    const doc = parseHtml(
      '<html><head></head><body><img src="blob:http://example.com/abc"></body></html>'
    );
    cleanResourceUrls(doc);
    const img = doc.querySelector('img');
    expect(img?.getAttribute('src')).toBe('blob:http://example.com/abc');
  });

  it('should skip styles without textContent', () => {
    const doc = parseHtml('<html><head><style></style></head><body></body></html>');
    cleanResourceUrls(doc); // Should not throw
    expect(doc.querySelector('style')?.textContent).toBe('');
  });
});

describe('makeInert', () => {
  it('should return valid HTML with DOCTYPE', () => {
    const result = makeInert('<html><head></head><body></body></html>');
    expect(result).toMatch(/^<!DOCTYPE html>/);
  });

  it('should remove script and noscript tags', () => {
    const html =
      '<html><head></head><body><script>alert(1)</script><noscript>JS off</noscript><p>Content</p></body></html>';
    const result = makeInert(html);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('<noscript');
    expect(result).toContain('Content');
  });

  it('should disable links by moving href to data-original-href', () => {
    const html = '<html><head></head><body><a href="https://example.com">Link</a></body></html>';
    const result = makeInert(html);
    expect(result).toContain('data-original-href="https://example.com"');
    // href should be removed
    const doc = new DOMParser().parseFromString(result, 'text/html');
    const link = doc.querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);
  });

  it('should disable form actions', () => {
    const html = '<html><head></head><body><form action="/submit"></form></body></html>';
    const result = makeInert(html);
    const doc = new DOMParser().parseFromString(result, 'text/html');
    const form = doc.querySelector('form');
    expect(form?.hasAttribute('action')).toBe(false);
  });

  it('should disable interactive elements with disabled attribute', () => {
    const html =
      '<html><head></head><body><button>Click</button><input type="text"><select></select><textarea></textarea></body></html>';
    const result = makeInert(html);
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('input')?.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('select')?.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('textarea')?.hasAttribute('disabled')).toBe(true);
  });

  it('should remove event handler attributes', () => {
    const html =
      '<html><head></head><body><div onclick="alert(1)" onmouseover="void(0)" onload="bad()" onerror="err()" onsubmit="sub()" onchange="ch()" onfocus="f()" onblur="b()" onmouseout="m()">Content</div></body></html>';
    const result = makeInert(html);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('onmouseover');
    expect(result).not.toContain('onload');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('onsubmit');
    expect(result).not.toContain('onchange');
    expect(result).not.toContain('onfocus');
    expect(result).not.toContain('onblur');
    expect(result).not.toContain('onmouseout');
  });

  it('should add refine-page-snapshot meta tag', () => {
    const result = makeInert('<html><head></head><body></body></html>');
    expect(result).toContain('name="refine-page-snapshot"');
  });

  it('should add CSP meta tag', () => {
    const result = makeInert('<html><head></head><body></body></html>');
    expect(result).toContain('Content-Security-Policy');
    expect(result).toContain("script-src 'none'");
  });

  it('should add inert styles', () => {
    const result = makeInert('<html><head></head><body></body></html>');
    expect(result).toContain('pointer-events: none');
  });

  it('should set base URL when provided', () => {
    const result = makeInert('<html><head></head><body></body></html>', 'https://example.com');
    expect(result).toContain('href="https://example.com"');
  });

  it('should reuse existing base element', () => {
    const html = '<html><head><base href="https://old.com"></head><body></body></html>';
    const result = makeInert(html, 'https://new.com');
    expect(result).toContain('href="https://new.com"');
    const baseCount = (result.match(/<base /g) || []).length;
    expect(baseCount).toBe(1);
  });

  it('should work without base URL', () => {
    const result = makeInert('<html><head></head><body><p>Hello</p></body></html>');
    expect(result).toContain('Hello');
    expect(result).not.toContain('<base ');
  });

  it('should clean resource URLs in the document', () => {
    const html =
      '<html><head><style>body { background: url(https://cdn.com/bg.png); }</style></head><body><img src="https://cdn.com/img.png"></body></html>';
    const result = makeInert(html);
    expect(result).not.toContain('https://cdn.com/bg.png');
    expect(result).toContain('data-original-src');
  });
});
