/**
 * Annotator script that runs inside the iframe context
 * This allows Recogito to properly detect text selections
 */

import { createTextAnnotator } from '@recogito/text-annotator';
import '@recogito/text-annotator/text-annotator.css';

// Types for messages
interface AnnotatorMessage {
  type: string;
  payload?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let annotator: any = null;
let currentTool: 'select' | 'relevant' | 'answer' = 'select';
let isReady = false;

// Initialize annotator on the content
function initializeAnnotator(container: HTMLElement) {
  console.log('[Iframe Annotator] Initializing annotator on container');

  // Destroy existing annotator if any
  if (annotator) {
    try {
      annotator.destroy();
    } catch (e) {
      console.warn('[Iframe Annotator] Error destroying previous annotator:', e);
    }
  }

  annotator = createTextAnnotator(container, {
    annotatingEnabled: currentTool !== 'select',
  });

  if (currentTool !== 'select') {
    annotator.setAnnotatingMode('CREATE_NEW');
  }

  console.log('[Iframe Annotator] Text annotator created');

  // Handle annotation creation
  annotator.on('createAnnotation', (annotation: unknown) => {
    if (currentTool === 'select') return;

    console.log('[Iframe Annotator] Annotation created:', annotation);

    window.parent.postMessage({
      type: 'ANNOTATION_CREATED',
      payload: { annotation, tool: currentTool }
    }, '*');
  });

  // Handle annotation deletion
  annotator.on('deleteAnnotation', (annotation: unknown) => {
    console.log('[Iframe Annotator] Annotation deleted:', annotation);

    window.parent.postMessage({
      type: 'ANNOTATION_DELETED',
      payload: { annotation }
    }, '*');
  });
}

// Handle messages from parent
function handleMessage(event: MessageEvent) {
  const message = event.data as AnnotatorMessage;
  if (!message?.type) return;

  console.log('[Iframe Annotator] Received message:', message.type);

  switch (message.type) {
    case 'LOAD_HTML': {
      // Load HTML content into the page
      const { html } = message.payload as { html: string };
      const container = document.getElementById('content-container');
      if (container && html) {
        // Insert the HTML content
        container.innerHTML = html;
        console.log('[Iframe Annotator] HTML content loaded');

        // Initialize annotator on the loaded content
        initializeAnnotator(container);

        // Signal ready
        window.parent.postMessage({ type: 'ANNOTATOR_READY' }, '*');
      }
      break;
    }

    case 'SET_TOOL':
      currentTool = message.payload as 'select' | 'relevant' | 'answer';
      if (annotator) {
        const enabled = currentTool !== 'select';
        annotator.setAnnotatingEnabled(enabled);
        if (enabled) {
          annotator.setAnnotatingMode('CREATE_NEW');
        }
        console.log('[Iframe Annotator] Tool set to:', currentTool, 'enabled:', enabled);
      }
      break;

    case 'LOAD_ANNOTATIONS':
      if (annotator) {
        const annotations = message.payload as unknown[];
        if (annotations?.length) {
          annotator.setAnnotations(annotations);
          console.log('[Iframe Annotator] Loaded', annotations.length, 'annotations');
        }
      }
      break;

    case 'CLEAR_ANNOTATIONS':
      if (annotator) {
        annotator.clearAnnotations();
      }
      break;
  }
}

// Initialize
console.log('[Iframe Annotator] Script loaded, waiting for messages...');
window.addEventListener('message', handleMessage);

// Signal that the iframe is ready to receive content
window.parent.postMessage({ type: 'IFRAME_LOADED' }, '*');
