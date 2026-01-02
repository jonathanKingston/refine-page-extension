/**
 * Content script for refine.page extension
 * Provides page metadata to the background script for MHTML capture
 */

interface PageMetadata {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
}

// Get current page metadata
function getPageMetadata(): PageMetadata {
  return {
    url: window.location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_METADATA') {
    sendResponse({ type: 'PAGE_METADATA', payload: getPageMetadata() });
    return true;
  }
});

console.log('refine.page: Content script loaded');
