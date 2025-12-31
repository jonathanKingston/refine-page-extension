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

// Color mapping for annotation types
const ANNOTATION_COLORS: Record<string, string> = {
  relevant: 'rgba(34, 197, 94, 0.4)',  // green
  answer: 'rgba(59, 130, 246, 0.4)',    // blue
};

// Serialize annotation to remove non-cloneable objects (like Range)
function serializeAnnotation(annotation: unknown): unknown {
  // Deep clone by converting to JSON and back - removes non-serializable objects
  try {
    return JSON.parse(JSON.stringify(annotation));
  } catch (e) {
    console.warn('[Iframe Annotator] Failed to serialize annotation:', e);
    // Manual extraction of key fields
    const ann = annotation as Record<string, unknown>;
    return {
      '@context': ann['@context'],
      type: ann.type,
      id: ann.id,
      body: ann.body,
      target: ann.target,
    };
  }
}

// Apply custom styling to annotations based on tool type
function applyAnnotationStyle(annotationId: string, tool: string) {
  // Find the annotation elements and apply color
  setTimeout(() => {
    const color = ANNOTATION_COLORS[tool] || ANNOTATION_COLORS.relevant;
    // Recogito uses data attributes on highlight spans
    const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
    elements.forEach(el => {
      (el as HTMLElement).style.backgroundColor = color;
      el.classList.add(`annotation-${tool}`);
    });
  }, 50);
}

// Get style for annotation based on type
function getAnnotationStyle(tool: string): { fill: string; fillOpacity: number } {
  if (tool === 'answer') {
    return { fill: '#3b82f6', fillOpacity: 0.4 }; // blue
  }
  return { fill: '#22c55e', fillOpacity: 0.4 }; // green (relevant)
}

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

  // Add custom styles for annotation colors
  injectAnnotationStyles();

  annotator = createTextAnnotator(container, {
    annotatingEnabled: currentTool !== 'select',
    // Style function to color annotations based on current tool
    style: () => getAnnotationStyle(currentTool),
  });

  if (currentTool !== 'select') {
    annotator.setAnnotatingMode('CREATE_NEW');
  }

  console.log('[Iframe Annotator] Text annotator created');

  // Handle annotation creation
  annotator.on('createAnnotation', (annotation: unknown) => {
    if (currentTool === 'select') return;

    console.log('[Iframe Annotator] Annotation created:', annotation);

    // Serialize to remove non-cloneable objects
    const serialized = serializeAnnotation(annotation);
    const ann = annotation as { id?: string };

    // Apply styling
    if (ann.id) {
      applyAnnotationStyle(ann.id, currentTool);
    }

    window.parent.postMessage({
      type: 'ANNOTATION_CREATED',
      payload: { annotation: serialized, tool: currentTool }
    }, '*');
  });

  // Handle annotation deletion
  annotator.on('deleteAnnotation', (annotation: unknown) => {
    console.log('[Iframe Annotator] Annotation deleted:', annotation);

    const serialized = serializeAnnotation(annotation);

    window.parent.postMessage({
      type: 'ANNOTATION_DELETED',
      payload: { annotation: serialized }
    }, '*');
  });

  // Handle annotation click/selection
  annotator.on('clickAnnotation', (annotation: unknown) => {
    console.log('[Iframe Annotator] Annotation clicked:', annotation);
    const ann = annotation as { id?: string };
    if (ann.id) {
      highlightAnnotation(ann.id);
      window.parent.postMessage({
        type: 'ANNOTATION_CLICKED',
        payload: { annotationId: ann.id }
      }, '*');
    }
  });
}

// Highlight a specific annotation and scroll to it
function highlightAnnotation(annotationId: string) {
  // Remove previous selection
  document.querySelectorAll('.selected, .pl-selected').forEach(el => {
    el.classList.remove('selected', 'pl-selected');
  });

  // Find and highlight the annotation
  const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
  if (elements.length > 0) {
    elements.forEach(el => {
      el.classList.add('selected', 'pl-selected');
    });
    elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// Inject custom styles for annotation colors
function injectAnnotationStyles() {
  if (document.getElementById('pl-annotation-styles')) return;

  const style = document.createElement('style');
  style.id = 'pl-annotation-styles';
  style.textContent = `
    /* Custom annotation colors for relevant (green) */
    .annotation-relevant,
    [data-annotation].annotation-relevant {
      background-color: rgba(34, 197, 94, 0.4) !important;
      border-bottom: 2px solid rgb(34, 197, 94) !important;
    }
    /* Custom annotation colors for answer (blue) */
    .annotation-answer,
    [data-annotation].annotation-answer {
      background-color: rgba(59, 130, 246, 0.4) !important;
      border-bottom: 2px solid rgb(59, 130, 246) !important;
    }
    /* Recogito highlight layer styling */
    .r6o-annotation,
    .r6o-span-highlight-layer .r6o-annotation {
      cursor: pointer;
      transition: all 0.2s ease;
      border-radius: 2px;
    }
    .r6o-annotation:hover {
      filter: brightness(0.85);
    }
    /* Selected annotation */
    .r6o-annotation.selected,
    [data-annotation].selected {
      outline: 2px solid #f59e0b !important;
      outline-offset: 1px;
    }
    /* Make sure annotations are visible */
    .r6o-canvas-highlight-layer,
    .r6o-span-highlight-layer {
      pointer-events: none;
      z-index: 1000;
    }
    .r6o-span-highlight-layer .r6o-annotation {
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
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
        const annotations = message.payload as Array<{
          id?: string;
          body?: Array<{ value?: string }>;
        }>;
        if (annotations?.length) {
          annotator.setAnnotations(annotations);
          console.log('[Iframe Annotator] Loaded', annotations.length, 'annotations');
          // Apply styles to loaded annotations
          setTimeout(() => {
            for (const ann of annotations) {
              if (ann.id) {
                // Extract type from body
                const typeBody = ann.body?.find(b => b.value === 'relevant' || b.value === 'answer');
                const tool = typeBody?.value || 'relevant';
                applyAnnotationStyle(ann.id, tool);
              }
            }
          }, 100);
        }
      }
      break;

    case 'CLEAR_ANNOTATIONS':
      if (annotator) {
        annotator.clearAnnotations();
      }
      break;

    case 'SCROLL_TO_ANNOTATION': {
      const { annotationId } = message.payload as { annotationId: string };
      if (annotationId) {
        highlightAnnotation(annotationId);
      }
      break;
    }
  }
}

// Initialize
console.log('[Iframe Annotator] Script loaded, waiting for messages...');
window.addEventListener('message', handleMessage);

// Signal that the iframe is ready to receive content
window.parent.postMessage({ type: 'IFRAME_LOADED' }, '*');
