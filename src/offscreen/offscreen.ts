/**
 * Offscreen document for refine.page extension
 * Handles MHTML to HTML conversion using DOM APIs not available in service workers
 */

import * as mhtml2html from 'mhtml2html';
import { makeInert } from './inert';

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
