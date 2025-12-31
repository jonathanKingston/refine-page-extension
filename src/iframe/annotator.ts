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
let annotationIndex = 0; // Track annotation numbers

// Store annotation metadata for re-applying styles after Recogito re-renders
const annotationMeta: Map<string, { tool: string; index: number }> = new Map();

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
function applyAnnotationStyle(annotationId: string, tool: string, index?: number) {
  // Store metadata for re-applying after Recogito re-renders
  if (index !== undefined) {
    annotationMeta.set(annotationId, { tool, index });
  }

  // Find the annotation elements and apply color
  const color = ANNOTATION_COLORS[tool] || ANNOTATION_COLORS.relevant;
  // Recogito uses data attributes on highlight spans
  const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
  elements.forEach((el, i) => {
    (el as HTMLElement).style.backgroundColor = color;
    el.classList.add(`annotation-${tool}`);
    // Add number badge to first element only
    if (i === 0 && index !== undefined) {
      el.setAttribute('data-annotation-index', String(index));
      el.classList.add('has-index');
    }
  });
}

// Re-apply all annotation styles (called by MutationObserver)
function reapplyAllStyles() {
  annotationMeta.forEach((meta, annotationId) => {
    const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
    if (elements.length > 0) {
      const color = ANNOTATION_COLORS[meta.tool] || ANNOTATION_COLORS.relevant;
      elements.forEach((el, i) => {
        // Only apply if not already styled
        if (!el.classList.contains(`annotation-${meta.tool}`)) {
          (el as HTMLElement).style.backgroundColor = color;
          el.classList.add(`annotation-${meta.tool}`);
          if (i === 0) {
            el.setAttribute('data-annotation-index', String(meta.index));
            el.classList.add('has-index');
          }
        }
      });
    }
  });
}


// MutationObserver to re-apply styles when Recogito re-renders
let styleObserver: MutationObserver | null = null;

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

  // Clear old observer
  if (styleObserver) {
    styleObserver.disconnect();
  }

  // Clear old metadata
  annotationMeta.clear();

  // Add custom styles for annotation colors
  injectAnnotationStyles();

  // Don't use style function - it would apply currentTool color to ALL annotations
  // Instead we apply colors per-annotation via applyAnnotationStyle
  annotator = createTextAnnotator(container, {
    annotatingEnabled: currentTool !== 'select',
  });

  // Set up MutationObserver to re-apply styles when Recogito modifies DOM
  styleObserver = new MutationObserver(() => {
    // Debounce re-application
    requestAnimationFrame(() => {
      reapplyAllStyles();
    });
  });

  styleObserver.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
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

    // Increment index and apply styling with number
    annotationIndex++;
    if (ann.id) {
      applyAnnotationStyle(ann.id, currentTool, annotationIndex);
    }

    window.parent.postMessage({
      type: 'ANNOTATION_CREATED',
      payload: { annotation: serialized, tool: currentTool, index: annotationIndex }
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
  console.log('[Iframe Annotator] Highlighting annotation:', annotationId);

  // Remove previous selection
  document.querySelectorAll('.selected, .pl-selected').forEach(el => {
    el.classList.remove('selected', 'pl-selected');
  });

  // Find and highlight the annotation - try multiple selectors
  const selectors = [
    `[data-annotation="${annotationId}"]`,
    `[data-id="${annotationId}"]`,
    `.r6o-annotation[data-annotation="${annotationId}"]`,
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    console.log('[Iframe Annotator] Trying selector:', selector, 'found:', elements.length);
    if (elements.length > 0) {
      elements.forEach(el => {
        el.classList.add('selected', 'pl-selected');
      });
      elements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  console.log('[Iframe Annotator] No elements found for annotation:', annotationId);
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
      background-color: rgba(34, 197, 94, 0.35) !important;
      border-bottom: 2px solid rgb(34, 197, 94) !important;
    }
    /* Custom annotation colors for answer (blue) */
    .annotation-answer,
    [data-annotation].annotation-answer {
      background-color: rgba(59, 130, 246, 0.35) !important;
      border-bottom: 2px solid rgb(59, 130, 246) !important;
    }
    /* Number badge for annotations - always visible */
    .has-index {
      position: relative;
    }
    .has-index::before {
      content: attr(data-annotation-index);
      position: absolute;
      top: -10px;
      left: -4px;
      background: #374151;
      color: white;
      font-size: 10px;
      font-weight: bold;
      min-width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
      border-radius: 8px;
      padding: 0 4px;
      z-index: 1001;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      pointer-events: none;
    }
    .has-index.annotation-relevant::before {
      background: rgb(22, 163, 74);
    }
    .has-index.annotation-answer::before {
      background: rgb(37, 99, 235);
    }
    /* Hover effect on annotations */
    [data-annotation] {
      cursor: pointer;
      transition: all 0.15s ease;
    }
    [data-annotation]:hover {
      filter: brightness(0.9);
      box-shadow: 0 0 0 2px rgba(0,0,0,0.1);
    }
    /* Selected annotation */
    [data-annotation].selected,
    [data-annotation].pl-selected {
      outline: 2px solid #f59e0b !important;
      outline-offset: 1px;
    }
    .has-index.selected::before,
    .has-index.pl-selected::before {
      background: #f59e0b !important;
    }
    /* Make sure annotation layers work correctly */
    .r6o-canvas-highlight-layer,
    .r6o-span-highlight-layer {
      pointer-events: none;
      z-index: 1000;
    }
    .r6o-span-highlight-layer .r6o-annotation,
    .r6o-span-highlight-layer [data-annotation] {
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
        // Reset annotation index for new content
        annotationIndex = 0;

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
          bodies?: Array<{ value?: string }>;
        }>;
        console.log('[Iframe Annotator] LOAD_ANNOTATIONS received:', annotations);
        if (annotations?.length) {
          // Reset annotation index and set to count of loaded annotations
          annotationIndex = annotations.length;
          try {
            annotator.setAnnotations(annotations);
            console.log('[Iframe Annotator] setAnnotations called successfully');
          } catch (e) {
            console.error('[Iframe Annotator] setAnnotations error:', e);
          }
          console.log('[Iframe Annotator] Loaded', annotations.length, 'annotations');
          // Apply styles to loaded annotations with numbers
          setTimeout(() => {
            annotations.forEach((ann, idx) => {
              if (ann.id) {
                // Extract type from bodies (Recogito v3 format)
                const typeBody = ann.bodies?.find(b => b.value === 'relevant' || b.value === 'answer');
                const tool = typeBody?.value || 'relevant';
                console.log('[Iframe Annotator] Applying style to', ann.id, 'tool:', tool, 'index:', idx + 1);
                applyAnnotationStyle(ann.id, tool, idx + 1);
              }
            });
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
