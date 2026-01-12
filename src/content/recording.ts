/**
 * Recording content script for refine.page extension
 * Detects user interactions and sends them to background script for snapshot capture
 */

import type { InteractionRecord, CaptureConfig } from '@/types';

// Generate unique ID
function generateId(): string {
  return `interaction_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Get CSS selector for an element
function getSelector(element: Element): string {
  if (element.id) {
    return `#${element.id}`;
  }
  
  if (element.className) {
    const classes = element.className
      .split(' ')
      .filter((c) => c.length > 0)
      .map((c) => `.${c.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`)
      .join('');
    if (classes) {
      const selector = `${element.tagName.toLowerCase()}${classes}`;
      // Check if unique
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
  }
  
  // Fallback to path-based selector
  const path: string[] = [];
  let current: Element | null = element;
  
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    }
    if (current.className) {
      const classes = current.className
        .split(' ')
        .filter((c) => c.length > 0)
        .slice(0, 2)
        .map((c) => `.${c.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`)
        .join('');
      if (classes) {
        selector += classes;
      }
    }
    
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (el) => (el as Element).tagName === current!.tagName
      ) as Element[];
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    
    path.unshift(selector);
    current = parent;
  }
  
  return path.join(' > ');
}

// Get XPath for an element
function getXPath(element: Element): string {
  if (element.id) {
    return `//*[@id="${element.id}"]`;
  }
  
  const path: string[] = [];
  let current: Element | null = element;
  
  while (current && current !== document.body) {
    let index = 1;
    const siblings = Array.from(current.parentElement?.children || []).filter(
      (el) => el.tagName === current!.tagName
    );
    
    if (siblings.length > 1) {
      index = siblings.indexOf(current) + 1;
    }
    
    path.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }
  
  return '/' + path.join('/');
}

// Get element attributes (excluding sensitive ones)
function getAttributes(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of element.attributes) {
    // Skip sensitive attributes
    if (attr.name === 'password' || attr.name.includes('password')) {
      continue;
    }
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

// Get interaction target data
function getInteractionTarget(element: Element): InteractionRecord['action']['target'] {
  const rect = element.getBoundingClientRect();
  const text = element.textContent?.trim();
  
  return {
    selector: getSelector(element),
    xpath: getXPath(element),
    text: text ? (text.length > 100 ? text.substring(0, 100) + '...' : text) : undefined,
    attributes: getAttributes(element),
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

// Check if element is interactive
function isInteractive(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  const interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'label'];
  
  if (interactiveTags.includes(tagName)) {
    return true;
  }
  
  // Check for role attributes
  const role = element.getAttribute('role');
  if (role && ['button', 'link', 'menuitem', 'tab', 'option'].includes(role)) {
    return true;
  }
  
  // Check for event handlers or click handlers
  if (element.hasAttribute('onclick') || element.hasAttribute('data-action')) {
    return true;
  }
  
  // Check for tabindex (focusable)
  const tabIndex = element.getAttribute('tabindex');
  if (tabIndex !== null && parseInt(tabIndex) >= 0) {
    return true;
  }
  
  return false;
}

// Recording state
let isRecording = false;
let config: CaptureConfig | null = null;
let textInputDebounceTimer: number | null = null;
let lastInputElement: HTMLElement | null = null;
let eventListenersSetup = false; // Track if listeners are already set up
let initializationCheckInterval: ReturnType<typeof setInterval> | null = null;

// Initialize recording with retry logic for cross-origin navigation
async function initRecording(retryCount = 0) {
  // If already recording, don't re-initialize
  if (isRecording && eventListenersSetup) {
    return;
  }
  
  try {
    // Request recording state from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' });
    if (response?.isRecording && !isRecording) {
      isRecording = true;
      config = response.config || getDefaultConfig();
      setupEventListeners();
      console.log('[Recording] Initialized on', window.location.href);
      
      // Stop any polling if we successfully initialized
      if (initializationCheckInterval) {
        clearInterval(initializationCheckInterval);
        initializationCheckInterval = null;
      }
    }
  } catch (error) {
    // If we can't reach the background (e.g., extension reloaded), retry
    if (retryCount < 3) {
      console.log('[Recording] Retrying initialization...', retryCount + 1);
      setTimeout(() => initRecording(retryCount + 1), 500);
    } else {
      console.warn('[Recording] Failed to initialize after retries:', error);
    }
  }
}

// Get default capture config
function getDefaultConfig(): CaptureConfig {
  return {
    navigation: true,
    clicks: true,
    formSubmissions: true,
    textInput: true,
    selections: true,
    scrollThreshold: null,
    hoverDuration: null,
  };
}

// Setup event listeners for interaction detection
function setupEventListeners() {
  // Prevent duplicate listeners
  if (eventListenersSetup) {
    console.log('[Recording] Event listeners already set up, skipping');
    return;
  }
  
  // Click events
  if (config?.clicks) {
    document.addEventListener('click', handleClick, true);
  }
  
  // Form submission
  if (config?.formSubmissions) {
    document.addEventListener('submit', handleFormSubmit, true);
  }
  
  // Text input (debounced)
  if (config?.textInput) {
    document.addEventListener('input', handleTextInput, true);
    document.addEventListener('blur', handleInputBlur, true);
  }
  
  // Selection changes (dropdowns, checkboxes, radios)
  if (config?.selections) {
    document.addEventListener('change', handleSelectionChange, true);
  }
  
  // Navigation (popstate for SPA navigation)
  // Always capture navigations for timeline context, regardless of config
  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('hashchange', handleNavigation);
  
  // Full page navigation (beforeunload)
  window.addEventListener('beforeunload', handleBeforeUnload);
  
  eventListenersSetup = true;
  console.log('[Recording] Event listeners set up');
}

// Remove event listeners
function removeEventListeners() {
  if (!eventListenersSetup) return;
  
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('submit', handleFormSubmit, true);
  document.removeEventListener('input', handleTextInput, true);
  document.removeEventListener('blur', handleInputBlur, true);
  document.removeEventListener('change', handleSelectionChange, true);
  window.removeEventListener('popstate', handleNavigation);
  window.removeEventListener('hashchange', handleNavigation);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  
  eventListenersSetup = false;
  console.log('[Recording] Event listeners removed');
}

// Visual feedback for clicks
function showClickFeedback(element: Element, coordinates: { x: number; y: number }) {
  // Remove any existing feedback
  const existing = document.querySelector('.recording-click-feedback');
  if (existing) {
    existing.remove();
  }

  const feedback = document.createElement('div');
  feedback.className = 'recording-click-feedback';
  feedback.style.cssText = `
    position: fixed;
    left: ${coordinates.x}px;
    top: ${coordinates.y}px;
    width: 20px;
    height: 20px;
    border: 3px solid #3b82f6;
    border-radius: 50%;
    background: rgba(59, 130, 246, 0.2);
    pointer-events: none;
    z-index: 999999;
    transform: translate(-50%, -50%);
    animation: recording-click-pulse 0.6s ease-out forwards;
  `;

  // Add ripple effect
  const ripple = document.createElement('div');
  ripple.style.cssText = `
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
    border: 2px solid #3b82f6;
    border-radius: 50%;
    transform: translate(-50%, -50%);
    animation: recording-click-ripple 0.6s ease-out forwards;
  `;
  feedback.appendChild(ripple);

  // Add CSS animations if not already added
  if (!document.getElementById('recording-feedback-styles')) {
    const style = document.createElement('style');
    style.id = 'recording-feedback-styles';
    style.textContent = `
      @keyframes recording-click-pulse {
        0% {
          transform: translate(-50%, -50%) scale(0.8);
          opacity: 1;
        }
        100% {
          transform: translate(-50%, -50%) scale(1.5);
          opacity: 0;
        }
      }
      @keyframes recording-click-ripple {
        0% {
          width: 0;
          height: 0;
          opacity: 1;
        }
        100% {
          width: 60px;
          height: 60px;
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(feedback);

  // Remove after animation
  setTimeout(() => {
    if (feedback.parentNode) {
      feedback.remove();
    }
  }, 600);

  // Also highlight the element briefly
  const originalOutline = (element as HTMLElement).style.outline;
  (element as HTMLElement).style.outline = '3px solid #3b82f6';
  (element as HTMLElement).style.outlineOffset = '2px';
  
  setTimeout(() => {
    (element as HTMLElement).style.outline = originalOutline;
    (element as HTMLElement).style.outlineOffset = '';
  }, 1000);
}

// Handle click events
async function handleClick(event: MouseEvent) {
  if (!isRecording || !config?.clicks) return;
  
  const target = event.target as Element;
  if (!target) return;
  
  // Only capture clicks on interactive elements or elements that might trigger changes
  if (!isInteractive(target)) {
    // Check if it's a clickable container (has click handler)
    const hasClickHandler = target.hasAttribute('onclick') || 
                           target.getAttribute('role') === 'button' ||
                           window.getComputedStyle(target).cursor === 'pointer';
    if (!hasClickHandler) {
      return;
    }
  }
  
  // Don't capture password field clicks
  if (target instanceof HTMLInputElement && target.type === 'password') {
    return;
  }
  
  // Show visual feedback
  showClickFeedback(target, { x: event.clientX, y: event.clientY });
  
  const interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'> = {
    id: generateId(),
    timestamp: Date.now(),
    action: {
      type: 'click',
      target: getInteractionTarget(target),
      coordinates: { x: event.clientX, y: event.clientY },
    },
    url: window.location.href,
    title: document.title,
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
  
  // Send to background for snapshot capture
  try {
    await chrome.runtime.sendMessage({
      type: 'RECORD_INTERACTION',
      payload: { interaction, actionType: 'click' },
    });
    if (chrome.runtime.lastError) {
      console.error('[Recording] Error sending interaction:', chrome.runtime.lastError.message);
    } else {
      console.log('[Recording] Click interaction sent:', interaction.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to send click interaction:', error);
  }
}

// Handle form submission
async function handleFormSubmit(event: SubmitEvent) {
  if (!isRecording || !config?.formSubmissions) return;
  
  const target = event.target as HTMLFormElement;
  if (!target) return;
  
  const interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'> = {
    id: generateId(),
    timestamp: Date.now(),
    action: {
      type: 'submit',
      target: getInteractionTarget(target),
    },
    url: window.location.href,
    title: document.title,
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
  
  try {
    await chrome.runtime.sendMessage({
      type: 'RECORD_INTERACTION',
      payload: { interaction, actionType: 'submit' },
    });
    if (chrome.runtime.lastError) {
      console.error('[Recording] Error sending form submit:', chrome.runtime.lastError.message);
    } else {
      console.log('[Recording] Form submit interaction sent:', interaction.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to send form submit interaction:', error);
  }
}

// Handle text input (debounced)
function handleTextInput(event: Event) {
  if (!isRecording || !config?.textInput) return;
  
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!target || (target.type === 'password')) return;
  
  lastInputElement = target;
  
  // Clear existing timer
  if (textInputDebounceTimer) {
    clearTimeout(textInputDebounceTimer);
  }
  
  // Set new timer (will capture on blur or after delay)
  textInputDebounceTimer = window.setTimeout(() => {
    captureTextInput(target);
  }, 1000); // 1 second debounce
}

// Handle input blur (capture immediately)
async function handleInputBlur(event: FocusEvent) {
  if (!isRecording || !config?.textInput) return;
  
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (!target || target !== lastInputElement) return;
  
  if (textInputDebounceTimer) {
    clearTimeout(textInputDebounceTimer);
    textInputDebounceTimer = null;
  }
  
  await captureTextInput(target);
  lastInputElement = null;
}

// Capture text input interaction
async function captureTextInput(target: HTMLInputElement | HTMLTextAreaElement) {
  const interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'> = {
    id: generateId(),
    timestamp: Date.now(),
    action: {
      type: 'type',
      target: getInteractionTarget(target),
      value: target.value, // Note: password fields are filtered out earlier
    },
    url: window.location.href,
    title: document.title,
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
  
  try {
    await chrome.runtime.sendMessage({
      type: 'RECORD_INTERACTION',
      payload: { interaction, actionType: 'type' },
    });
    if (chrome.runtime.lastError) {
      console.error('[Recording] Error sending text input:', chrome.runtime.lastError.message);
    } else {
      console.log('[Recording] Text input interaction sent:', interaction.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to send text input interaction:', error);
  }
}

// Handle selection changes
async function handleSelectionChange(event: Event) {
  if (!isRecording || !config?.selections) return;
  
  const target = event.target as HTMLSelectElement | HTMLInputElement;
  if (!target) return;
  
  const interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'> = {
    id: generateId(),
    timestamp: Date.now(),
    action: {
      type: 'select',
      target: getInteractionTarget(target),
      value: target instanceof HTMLSelectElement 
        ? target.options[target.selectedIndex]?.value || ''
        : target.value,
    },
    url: window.location.href,
    title: document.title,
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
  };
  
  try {
    await chrome.runtime.sendMessage({
      type: 'RECORD_INTERACTION',
      payload: { interaction, actionType: 'select' },
    });
    if (chrome.runtime.lastError) {
      console.error('[Recording] Error sending selection:', chrome.runtime.lastError.message);
    } else {
      console.log('[Recording] Selection interaction sent:', interaction.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to send selection interaction:', error);
  }
}

// Handle navigation (SPA navigation - popstate/hashchange)
// Always capture navigations for timeline context, regardless of config
async function handleNavigation() {
  if (!isRecording) return;
  
  // Wait a bit for page to settle
  setTimeout(async () => {
    const interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'> = {
      id: generateId(),
      timestamp: Date.now(),
      action: {
        type: 'navigate',
        target: {
          selector: 'body',
          xpath: '/html/body',
          attributes: {},
          boundingBox: {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight,
          },
        },
      },
      url: window.location.href,
      title: document.title,
      viewportSize: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
    
    try {
      await chrome.runtime.sendMessage({
        type: 'RECORD_INTERACTION',
        payload: { interaction, actionType: 'navigate' },
      });
      if (chrome.runtime.lastError) {
        console.error('[Recording] Error sending navigation:', chrome.runtime.lastError.message);
      } else {
        console.log('[Recording] Navigation interaction sent:', interaction.id);
      }
    } catch (error) {
      console.error('[Recording] Failed to send navigation interaction:', error);
    }
  }, 500);
}

// Handle full page navigation (beforeunload - for links that navigate away)
function handleBeforeUnload() {
  if (!isRecording) return;
  
  // Notify background that this page is navigating away
  // The background script will handle re-injecting on the new page
  chrome.runtime.sendMessage({
    type: 'PAGE_NAVIGATING',
    payload: { url: window.location.href },
  }).catch(() => {
    // Ignore errors - page might be unloading
  });
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'START_RECORDING') {
    isRecording = true;
    config = message.payload?.config || getDefaultConfig();
    setupEventListeners();
    console.log('[Recording] Started on', window.location.href);
    sendResponse({ success: true });
  } else if (message.type === 'STOP_RECORDING') {
    isRecording = false;
    removeEventListeners();
    if (textInputDebounceTimer) {
      clearTimeout(textInputDebounceTimer);
      textInputDebounceTimer = null;
    }
    // Stop any polling
    if (initializationCheckInterval) {
      clearInterval(initializationCheckInterval);
      initializationCheckInterval = null;
    }
    console.log('[Recording] Stopped on', window.location.href);
    sendResponse({ success: true });
  } else if (message.type === 'GET_RECORDING_STATE') {
    sendResponse({ isRecording, config });
  }
  
  return true; // Keep channel open for async response
});

// Initialize on load - this runs automatically when content script loads on any page
// For cross-origin navigation, the script will auto-load and check recording state
function startInitialization() {
  // Initial check
  initRecording();
  
  // Also check periodically in case background hasn't sent message yet
  // This handles cross-origin navigation where the script loads before background sends message
  if (!initializationCheckInterval) {
    initializationCheckInterval = setInterval(async () => {
      if (!isRecording) {
        await initRecording();
      } else {
        // Stop checking once we're recording
        if (initializationCheckInterval) {
          clearInterval(initializationCheckInterval);
          initializationCheckInterval = null;
        }
      }
    }, 1000);
    
    // Stop checking after 10 seconds to avoid infinite polling
    setTimeout(() => {
      if (initializationCheckInterval) {
        clearInterval(initializationCheckInterval);
        initializationCheckInterval = null;
      }
    }, 10000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startInitialization);
} else {
  startInitialization();
}