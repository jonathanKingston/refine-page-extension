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

// Initialize when DOM is ready
function initialize() {
  console.log('[Iframe Annotator] Initializing...');

  let currentTool: 'select' | 'relevant' | 'answer' = 'select';

  const annotator = createTextAnnotator(document.body, {
    annotatingEnabled: false,
  });

  console.log('[Iframe Annotator] Text annotator created');

  // Handle annotation creation
  annotator.on('createAnnotation', (annotation: unknown) => {
    if (currentTool === 'select') return;

    console.log('[Iframe Annotator] Annotation created:', annotation);

    // Send to parent
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

  // Handle annotation selection
  annotator.on('selectionChanged', (annotations: unknown[]) => {
    window.parent.postMessage({
      type: 'SELECTION_CHANGED',
      payload: { annotations }
    }, '*');
  });

  // Listen for messages from parent
  window.addEventListener('message', (event) => {
    const message = event.data as AnnotatorMessage;
    if (!message?.type) return;

    console.log('[Iframe Annotator] Received message:', message.type);

    switch (message.type) {
      case 'SET_TOOL':
        currentTool = message.payload as 'select' | 'relevant' | 'answer';
        const enabled = currentTool !== 'select';
        annotator.setAnnotatingEnabled(enabled);
        if (enabled) {
          annotator.setAnnotatingMode('CREATE_NEW');
        }
        console.log('[Iframe Annotator] Tool set to:', currentTool, 'enabled:', enabled);
        break;

      case 'LOAD_ANNOTATIONS':
        const annotations = message.payload as unknown[];
        if (annotations?.length) {
          annotator.setAnnotations(annotations);
          console.log('[Iframe Annotator] Loaded', annotations.length, 'annotations');
        }
        break;

      case 'CLEAR_ANNOTATIONS':
        annotator.clearAnnotations();
        break;

      case 'ADD_ANNOTATION':
        annotator.addAnnotation(message.payload);
        break;

      case 'REMOVE_ANNOTATION':
        annotator.removeAnnotation(message.payload as string);
        break;
    }
  });

  // Signal to parent that we're ready
  window.parent.postMessage({ type: 'ANNOTATOR_READY' }, '*');
  console.log('[Iframe Annotator] Ready');
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
