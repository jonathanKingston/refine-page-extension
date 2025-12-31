/**
 * Viewer page for annotating and labeling snapshots
 * Uses @recogito/text-annotator for text and @annotorious/annotorious for images
 */

import type {
  Snapshot,
  Question,
  TextAnnotation,
  RegionAnnotation,
  AnnotationType,
  AnswerCorrectness,
  AnswerInPage,
  PageQuality,
} from '@/types';

// Import annotation libraries
import { createTextAnnotator } from '@recogito/text-annotator';
import { createImageAnnotator } from '@annotorious/annotorious';
import '@recogito/text-annotator/text-annotator.css';
import '@annotorious/annotorious/annotorious.css';

// Use any for annotator types to avoid complex type conflicts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAnnotator = any;

// Lightweight snapshot summary (without HTML) for listing
interface SnapshotSummary {
  id: string;
  url: string;
  title: string;
  status: Snapshot['status'];
  capturedAt: string;
  updatedAt: string;
  tags: string[];
  annotationCount: { text: number; region: number };
  questionCount: number;
}

// State
let currentSnapshot: Snapshot | null = null;
let currentQuestionId: string | null = null;
let currentTool: 'select' | AnnotationType = 'select';
let zoomLevel = 100;
let allSnapshots: SnapshotSummary[] = [];

// Annotation library instances
let textAnnotator: AnyAnnotator = null;
let imageAnnotators: Map<string, AnyAnnotator> = new Map();

// Color mapping for annotation types
const ANNOTATION_COLORS: Record<AnnotationType, string> = {
  relevant: '#22c55e',
  answer: '#3b82f6',
};

// Generate unique ID
function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Send message to background script
async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// Direct storage access - bypasses message passing to avoid size limits
async function getSnapshotIndex(): Promise<string[]> {
  const result = await chrome.storage.local.get('snapshotIndex');
  return result.snapshotIndex || [];
}

async function getSnapshotFromStorage(id: string): Promise<Snapshot | null> {
  const key = `snapshot_${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function getAllSnapshotsFromStorage(): Promise<Snapshot[]> {
  const index = await getSnapshotIndex();
  const keys = index.map((id) => `snapshot_${id}`);
  if (keys.length === 0) return [];

  const result = await chrome.storage.local.get(keys);
  return keys.map((key) => result[key]).filter(Boolean);
}

async function getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
  const snapshots = await getAllSnapshotsFromStorage();
  return snapshots.map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    status: s.status,
    capturedAt: s.capturedAt,
    updatedAt: s.updatedAt,
    tags: s.tags,
    annotationCount: { text: s.annotations.text.length, region: s.annotations.region.length },
    questionCount: s.questions.length,
  }));
}

// Get URL parameters
function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// Load snapshot into preview (direct storage access - no message size limits)
async function loadSnapshot(snapshotId: string) {
  try {
    const snapshot = await getSnapshotFromStorage(snapshotId);
    if (!snapshot) {
      console.error('Snapshot not found:', snapshotId);
      return;
    }

    currentSnapshot = snapshot;
    currentQuestionId = snapshot.questions.length > 0 ? snapshot.questions[0].id : null;

    // Clean up existing annotators
    destroyAnnotators();

    updateUI();
  } catch (error) {
    console.error('Failed to load snapshot:', error);
  }
}

// Destroy existing annotators
function destroyAnnotators() {
  if (textAnnotator) {
    textAnnotator.destroy();
    textAnnotator = null;
  }
  imageAnnotators.forEach((annotator) => annotator.destroy());
  imageAnnotators.clear();
}

// Update the entire UI
function updateUI() {
  if (!currentSnapshot) return;

  // Update page title
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    titleEl.textContent = currentSnapshot.title || currentSnapshot.url;
  }

  // Load HTML into iframe
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    // Create blob URL for the HTML content
    const blob = new Blob([currentSnapshot.html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    iframe.src = blobUrl;

    // Set up annotation handling after iframe loads
    iframe.onload = () => {
      initializeAnnotators(iframe);
    };
  }

  // Update question selector
  updateQuestionSelector();

  // Update annotation counts
  updateAnnotationCounts();

  // Update annotation list
  renderAnnotationList();

  // Update status
  updateStatusDisplay();

  // Update evaluation form
  updateEvaluationForm();

  // Update review notes
  const notesInput = document.getElementById('review-notes') as HTMLTextAreaElement;
  if (notesInput && currentSnapshot.reviewNotes) {
    notesInput.value = currentSnapshot.reviewNotes;
  }

  // Update snapshot navigation active state
  updateSnapshotNavActive();
}

// Track if iframe annotator is ready
let iframeAnnotatorReady = false;
let pendingIframeMessages: Array<{type: string; payload?: unknown}> = [];

// Send message to iframe annotator
function sendToIframe(iframe: HTMLIFrameElement, type: string, payload?: unknown) {
  if (!iframe.contentWindow) return;

  const message = { type, payload };
  if (iframeAnnotatorReady) {
    iframe.contentWindow.postMessage(message, '*');
  } else {
    pendingIframeMessages.push(message);
  }
}

// Initialize annotation libraries on iframe content
function initializeAnnotators(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc || !currentSnapshot) return;

  console.log('Initializing annotators on iframe document:', doc);

  // Reset iframe annotator state
  iframeAnnotatorReady = false;
  pendingIframeMessages = [];

  // Inject annotation styles into iframe (for image annotator and manual highlights)
  injectAnnotationStyles(doc);

  // Inject the iframe annotator script
  const script = doc.createElement('script');
  script.src = chrome.runtime.getURL('iframe-annotator.js');
  script.onload = () => {
    console.log('Iframe annotator script loaded');
  };
  script.onerror = (e) => {
    console.error('Failed to load iframe annotator script:', e);
  };
  doc.head.appendChild(script);

  // Listen for messages from iframe annotator
  const messageHandler = (event: MessageEvent) => {
    // Only accept messages from our iframe
    if (event.source !== iframe.contentWindow) return;

    const message = event.data;
    if (!message?.type) return;

    console.log('Message from iframe:', message.type, message.payload);

    switch (message.type) {
      case 'ANNOTATOR_READY':
        iframeAnnotatorReady = true;
        // Send any pending messages
        pendingIframeMessages.forEach(msg => {
          iframe.contentWindow?.postMessage(msg, '*');
        });
        pendingIframeMessages = [];
        // Send current tool state
        sendToIframe(iframe, 'SET_TOOL', currentTool);
        // Load existing annotations
        if (currentSnapshot?.annotations.text.length) {
          const w3cAnnotations = currentSnapshot.annotations.text.map(a => convertToW3CText(a));
          sendToIframe(iframe, 'LOAD_ANNOTATIONS', w3cAnnotations);
        }
        break;

      case 'ANNOTATION_CREATED':
        handleAnnotationCreated(message.payload);
        break;

      case 'ANNOTATION_DELETED':
        handleAnnotationDeleted(message.payload);
        break;
    }
  };

  window.addEventListener('message', messageHandler);

  // Store handler for cleanup
  (iframe as any)._messageHandler = messageHandler;

  // Forward keyboard events from iframe to parent for shortcuts
  doc.addEventListener('keydown', (e) => {
    const clonedEvent = new KeyboardEvent('keydown', {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
    });
    document.dispatchEvent(clonedEvent);
  });

  // Add click handler for annotation highlights to scroll sidebar
  doc.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const highlight = target.closest('[data-annotation], [data-id], [data-annotation-id], .pl-highlight, .r6o-annotation');
    if (highlight) {
      const annotationId = (highlight as HTMLElement).dataset.annotation ||
                          (highlight as HTMLElement).dataset.id ||
                          (highlight as HTMLElement).dataset.annotationId;
      if (annotationId) {
        scrollSidebarToAnnotation(annotationId);
      }
    }
  });

  // Initialize image annotators for each image
  initializeImageAnnotators(doc);
}

// Handle annotation created from iframe
function handleAnnotationCreated(payload: { annotation: unknown; tool: string }) {
  if (!currentSnapshot) return;

  const { annotation, tool } = payload;
  const textAnnotation = convertFromW3CText(annotation, tool as AnnotationType);

  if (textAnnotation) {
    currentSnapshot.annotations.text.push(textAnnotation);

    if (currentQuestionId) {
      const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
      if (question) {
        question.annotationIds.push(textAnnotation.id);
      }
    }

    updateAnnotationCounts();
    renderAnnotationList();
    saveCurrentSnapshot();
    console.log('Annotation created:', textAnnotation.id);
  }
}

// Handle annotation deleted from iframe
function handleAnnotationDeleted(payload: { annotation: unknown }) {
  if (!currentSnapshot) return;

  const annotation = payload.annotation as { id?: string };
  const id = annotation?.id;
  if (!id) return;

  currentSnapshot.annotations.text = currentSnapshot.annotations.text.filter(a => a.id !== id);

  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter(aid => aid !== id);
  }

  updateAnnotationCounts();
  renderAnnotationList();
  saveCurrentSnapshot();
}

// Inject CSS for annotation styling into iframe
function injectAnnotationStyles(doc: Document) {
  const style = doc.createElement('style');
  style.id = 'pl-annotation-styles';
  style.textContent = `
    /* Text annotator library CSS (from @recogito/text-annotator) */
    .r6o-canvas-highlight-layer{position:fixed;top:0;bottom:0;left:0;width:100vw;height:100vh;pointer-events:none}
    .r6o-canvas-highlight-layer.bg{mix-blend-mode:multiply;z-index:1}
    .r6o-annotatable .r6o-span-highlight-layer{position:absolute;top:0;left:0;width:100%;height:100%;mix-blend-mode:multiply;pointer-events:none;overflow:hidden;z-index:1}
    .r6o-annotatable .r6o-span-highlight-layer.hidden{display:none}
    .r6o-annotatable .r6o-span-highlight-layer .r6o-annotation{position:absolute;display:block;border-style:solid;border-width:0;box-sizing:content-box}
    .r6o-presence-layer{left:0;position:fixed;top:0;bottom:0;width:100vw;pointer-events:none}
    .r6o-annotatable{position:relative;-webkit-tap-highlight-color:transparent}
    .r6o-annotatable.no-focus-outline{outline:none}
    .hovered *{cursor:pointer}
    *::selection,::selection{background:#0080ff2e}
    ::-moz-selection{background:#0080ff2e}

    /* Image annotator library CSS (from @annotorious/annotorious) */
    .a9s-annotationlayer{box-sizing:border-box;height:100%;left:0;outline:none;position:absolute;top:0;touch-action:none;width:100%;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;-o-user-select:none;user-select:none}
    .a9s-annotationlayer.hover{cursor:pointer}
    .a9s-annotationlayer.hidden{display:none}
    .a9s-annotationlayer ellipse,.a9s-annotationlayer line,.a9s-annotationlayer path,.a9s-annotationlayer polygon,.a9s-annotationlayer rect{fill:transparent;shape-rendering:geometricPrecision;vector-effect:non-scaling-stroke;-webkit-tap-highlight-color:transparent}
    .a9s-touch-halo{fill:transparent;pointer-events:none;stroke-width:0;transition:fill .15s}
    .a9s-touch-halo.touched{fill:#fff6}
    .a9s-handle-buffer{fill:transparent}
    .a9s-handle [role=button]{cursor:inherit!important}
    .a9s-handle-dot{fill:#fff;pointer-events:none;stroke:#00000059;stroke-width:1px;vector-effect:non-scaling-stroke}
    .a9s-handle-dot.selected{fill:#1a1a1a;stroke:none}
    .a9s-shape-handle,.a9s-handle{cursor:move}
    .a9s-handle.a9s-corner-handle{cursor:crosshair}
    .a9s-annotationlayer .a9s-outer{display:none}
    .a9s-annotationlayer .a9s-inner{fill:#0000001f;stroke:#000;stroke-width:1px}
    rect.a9s-handle{fill:#000;rx:2px}

    /* Custom text annotator styles */
    .r6o-annotation {
      padding: 2px 0;
      border-radius: 3px;
      cursor: pointer;
    }
    .r6o-annotation:hover {
      filter: brightness(0.9);
    }
    .r6o-annotation.relevant {
      background-color: rgba(34, 197, 94, 0.4) !important;
      border-bottom: 2px solid rgb(34, 197, 94);
    }
    .r6o-annotation.answer {
      background-color: rgba(59, 130, 246, 0.4) !important;
      border-bottom: 2px solid rgb(59, 130, 246);
    }
    .r6o-annotation.selected {
      outline: 3px solid #f59e0b;
      outline-offset: 2px;
    }

    /* Custom image annotator styles */
    .a9s-annotationlayer {
      pointer-events: auto;
    }
    .a9s-annotation.relevant .a9s-inner {
      stroke: rgb(34, 197, 94) !important;
      fill: rgba(34, 197, 94, 0.2) !important;
    }
    .a9s-annotation.answer .a9s-inner {
      stroke: rgb(59, 130, 246) !important;
      fill: rgba(59, 130, 246, 0.2) !important;
    }
    .a9s-annotation.selected .a9s-inner {
      stroke-width: 3px !important;
    }

    /* Manual highlight fallback */
    .pl-highlight {
      padding: 2px 0;
      border-radius: 3px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .pl-highlight:hover {
      filter: brightness(0.9);
    }
    .pl-highlight.pl-relevant {
      background-color: rgba(34, 197, 94, 0.4) !important;
      border-bottom: 2px solid rgb(34, 197, 94);
    }
    .pl-highlight.pl-answer {
      background-color: rgba(59, 130, 246, 0.4) !important;
      border-bottom: 2px solid rgb(59, 130, 246);
    }
    .pl-highlight.pl-selected {
      outline: 3px solid #f59e0b;
      outline-offset: 2px;
    }
  `;
  doc.head?.appendChild(style);
}

// Load existing text annotations into the text annotator
function loadExistingTextAnnotations() {
  if (!textAnnotator || !currentSnapshot) return;

  for (const annotation of currentSnapshot.annotations.text) {
    try {
      // Create W3C annotation format for the library
      const w3cAnnotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotation.id,
        body: [{
          type: 'TextualBody',
          purpose: 'tagging',
          value: annotation.type,
        }],
        target: {
          source: currentSnapshot.id,
          selector: {
            type: 'TextQuoteSelector',
            exact: annotation.selectedText,
          },
        },
      };

      textAnnotator.addAnnotation(w3cAnnotation);
      updateAnnotationAppearance(annotation.id, annotation.type);
    } catch (error) {
      console.warn('Failed to load annotation:', annotation.selectedText.substring(0, 30), error);
    }
  }
}

// Update the visual appearance of an annotation based on its type
function updateAnnotationAppearance(annotationId: string, type: AnnotationType) {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  const doc = iframe?.contentDocument;
  if (!doc) return;

  // Find the annotation element and add the type class
  setTimeout(() => {
    const elements = doc.querySelectorAll(`[data-annotation="${annotationId}"], [data-id="${annotationId}"]`);
    elements.forEach(el => {
      el.classList.remove('relevant', 'answer', 'no_content');
      el.classList.add(type);
    });
  }, 50);
}

// Initialize image annotators for each image in the document
function initializeImageAnnotators(doc: Document) {
  if (!currentSnapshot) return;

  const images = doc.querySelectorAll('img');
  images.forEach((img, index) => {
    // Skip tiny images (icons, etc.)
    if (img.naturalWidth < 100 || img.naturalHeight < 100) return;

    try {
      const imgId = img.id || `img-${index}`;
      img.id = imgId;

      // Capture computed dimensions before Annotorious wraps the image
      // Use bounding rect if available, fall back to natural dimensions
      const rect = img.getBoundingClientRect();
      const computedStyle = doc.defaultView?.getComputedStyle(img);
      const width = rect.width > 0 ? rect.width :
                    (computedStyle?.width && computedStyle.width !== 'auto' ? parseFloat(computedStyle.width) : img.naturalWidth);
      const height = rect.height > 0 ? rect.height :
                     (computedStyle?.height && computedStyle.height !== 'auto' ? parseFloat(computedStyle.height) : img.naturalHeight);

      // Store original parent for reference
      const originalParent = img.parentElement;

      const annotator = createImageAnnotator(img, {
        drawingEnabled: currentTool !== 'select',
      });

      // Fix wrapper dimensions - Annotorious wraps the image in a container
      // that can collapse if the image's CSS layout depends on parent elements
      const wrapper = img.parentElement;
      if (wrapper && wrapper !== originalParent && width > 0 && height > 0) {
        // Set explicit dimensions on the wrapper to prevent collapse
        wrapper.style.cssText = `
          display: inline-block !important;
          width: ${width}px !important;
          height: ${height}px !important;
          position: relative !important;
          max-width: 100% !important;
        `;
        // Ensure the image fills the wrapper properly
        img.style.cssText = `
          width: 100% !important;
          height: 100% !important;
          object-fit: contain !important;
          display: block !important;
        `;
      }

      annotator.on('createAnnotation', (annotation: any) => {
        if (currentTool === 'select' || !currentSnapshot) return;

        const regionAnnotation = convertFromW3CRegion(annotation, currentTool, imgId);
        if (regionAnnotation) {
          currentSnapshot.annotations.region.push(regionAnnotation);

          if (currentQuestionId) {
            const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
            if (question) {
              question.annotationIds.push(regionAnnotation.id);
            }
          }

          updateAnnotationCounts();
          renderAnnotationList();
          saveCurrentSnapshot();
        }
      });

      annotator.on('deleteAnnotation', (annotation: any) => {
        if (!currentSnapshot) return;
        const id = annotation.id;
        currentSnapshot.annotations.region = currentSnapshot.annotations.region.filter(a => a.id !== id);

        for (const question of currentSnapshot.questions) {
          question.annotationIds = question.annotationIds.filter(aid => aid !== id);
        }

        updateAnnotationCounts();
        renderAnnotationList();
        saveCurrentSnapshot();
      });

      // Load existing region annotations for this image
      loadExistingRegionAnnotations(annotator, imgId);

      imageAnnotators.set(imgId, annotator);
    } catch (error) {
      console.warn('Failed to initialize image annotator:', error);
    }
  });
}

// Load existing region annotations for an image
function loadExistingRegionAnnotations(annotator: AnyAnnotator, imgId: string) {
  if (!currentSnapshot) return;

  const regionAnnotations = currentSnapshot.annotations.region.filter(
    a => a.targetSelector === imgId
  );

  for (const annotation of regionAnnotations) {
    try {
      const w3cAnnotation = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotation.id,
        body: [{
          type: 'TextualBody',
          purpose: 'tagging',
          value: annotation.type,
        }],
        target: {
          source: imgId,
          selector: {
            type: 'FragmentSelector',
            conformsTo: 'http://www.w3.org/TR/media-frags/',
            value: `xywh=percent:${annotation.bounds.x},${annotation.bounds.y},${annotation.bounds.width},${annotation.bounds.height}`,
          },
        },
      };

      annotator.addAnnotation(w3cAnnotation);
    } catch (error) {
      console.warn('Failed to load region annotation:', error);
    }
  }
}

// Convert our text annotation format to W3C format for Recogito
function convertToW3CText(annotation: TextAnnotation): unknown {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotation.id,
    body: [{
      type: 'TextualBody',
      purpose: 'tagging',
      value: annotation.type,
    }],
    target: {
      selector: [{
        type: 'TextQuoteSelector',
        exact: annotation.selectedText,
      }]
    }
  };
}

// Convert W3C text annotation to our format
function convertFromW3CText(w3c: any, type: AnnotationType): TextAnnotation | null {
  try {
    const selector = Array.isArray(w3c.target?.selector)
      ? w3c.target.selector.find((s: any) => s.type === 'TextQuoteSelector')
      : w3c.target?.selector;

    if (!selector || selector.type !== 'TextQuoteSelector') return null;

    return {
      id: w3c.id || generateId(),
      type,
      startOffset: 0,
      endOffset: 0,
      selectedText: selector.exact || '',
      selector: {
        type: 'text-position',
        value: '0:0',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to convert text annotation:', error);
    return null;
  }
}

// Convert W3C region annotation to our format
function convertFromW3CRegion(w3c: any, type: AnnotationType, targetSelector: string): RegionAnnotation | null {
  try {
    const selector = w3c.target?.selector;
    if (!selector) return null;

    // Parse xywh fragment
    let bounds = { x: 0, y: 0, width: 0, height: 0 };

    if (selector.type === 'FragmentSelector') {
      const match = selector.value?.match(/xywh=(?:percent:)?([^,]+),([^,]+),([^,]+),([^,]+)/);
      if (match) {
        bounds = {
          x: parseFloat(match[1]),
          y: parseFloat(match[2]),
          width: parseFloat(match[3]),
          height: parseFloat(match[4]),
        };
      }
    }

    return {
      id: w3c.id || generateId(),
      type,
      bounds,
      targetSelector,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Failed to convert region annotation:', error);
    return null;
  }
}

// Fallback: render annotations manually if library fails
function renderAnnotationsManually(doc: Document) {
  if (!currentSnapshot) return;

  for (const annotation of currentSnapshot.annotations.text) {
    highlightTextManually(doc, annotation);
  }
}

// Manual text highlighting (fallback)
function highlightTextManually(doc: Document, annotation: TextAnnotation) {
  const searchText = annotation.selectedText;
  if (!searchText) return;

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    const index = text.indexOf(searchText);

    if (index !== -1) {
      try {
        const range = doc.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + searchText.length);

        const highlight = doc.createElement('mark');
        highlight.className = `pl-highlight pl-${annotation.type}`;
        highlight.dataset.annotationId = annotation.id;

        range.surroundContents(highlight);
        return;
      } catch {
        continue;
      }
    }
  }
}

// Scroll to and highlight annotation in iframe
function scrollToAnnotation(annotationId: string) {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  const doc = iframe?.contentDocument;
  if (!doc) return;

  // Remove previous selection
  doc.querySelectorAll('.selected, .pl-selected').forEach(el => {
    el.classList.remove('selected', 'pl-selected');
  });

  // Find and highlight the annotation
  const selectors = [
    `[data-annotation="${annotationId}"]`,
    `[data-id="${annotationId}"]`,
    `[data-annotation-id="${annotationId}"]`,
  ];

  for (const selector of selectors) {
    const highlight = doc.querySelector(selector);
    if (highlight) {
      highlight.classList.add('selected', 'pl-selected');
      highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }
}

// Scroll sidebar annotation list to show the annotation
function scrollSidebarToAnnotation(annotationId: string) {
  const listEl = document.getElementById('annotation-list');
  if (!listEl) return;

  // Find the annotation item in the sidebar
  const item = listEl.querySelector(`.annotation-item[data-id="${annotationId}"]`);
  if (item) {
    // Remove previous selection
    listEl.querySelectorAll('.annotation-item').forEach(i => i.classList.remove('selected'));
    // Add selection to this item
    item.classList.add('selected');
    // Scroll into view
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Update question selector
function updateQuestionSelector() {
  if (!currentSnapshot) return;

  const select = document.getElementById('question-select') as HTMLSelectElement;
  if (!select) return;

  select.innerHTML = '<option value="">Select or add a question...</option>';

  for (const question of currentSnapshot.questions) {
    const option = document.createElement('option');
    option.value = question.id;
    option.textContent = question.query.substring(0, 50) + (question.query.length > 50 ? '...' : '');
    select.appendChild(option);
  }

  if (currentQuestionId) {
    select.value = currentQuestionId;
    updateQuestionForm();
  }
}

// Update question form
function updateQuestionForm() {
  if (!currentSnapshot || !currentQuestionId) {
    clearQuestionForm();
    return;
  }

  const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
  if (!question) {
    clearQuestionForm();
    return;
  }

  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  const answerInput = document.getElementById('expected-answer') as HTMLTextAreaElement;

  if (queryInput) queryInput.value = question.query;
  if (answerInput) answerInput.value = question.expectedAnswer;
}

// Clear question form
function clearQuestionForm() {
  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  const answerInput = document.getElementById('expected-answer') as HTMLTextAreaElement;

  if (queryInput) queryInput.value = '';
  if (answerInput) answerInput.value = '';
}

// Update annotation counts
function updateAnnotationCounts() {
  if (!currentSnapshot) return;

  const textAnnotations = currentSnapshot.annotations.text;
  const regionAnnotations = currentSnapshot.annotations.region;
  const allAnnotations = [...textAnnotations, ...regionAnnotations];

  const relevantCount = allAnnotations.filter(a => a.type === 'relevant').length;
  const answerCount = allAnnotations.filter(a => a.type === 'answer').length;

  const relevantEl = document.getElementById('relevant-count');
  const answerEl = document.getElementById('answer-count');

  if (relevantEl) relevantEl.textContent = String(relevantCount);
  if (answerEl) answerEl.textContent = String(answerCount);
}

// Render annotation list
function renderAnnotationList() {
  const listEl = document.getElementById('annotation-list');
  if (!listEl || !currentSnapshot) return;

  const textAnnotations = currentSnapshot.annotations.text;
  const regionAnnotations = currentSnapshot.annotations.region;

  if (textAnnotations.length === 0 && regionAnnotations.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No annotations yet. Select text or draw on images to annotate.</div>';
    return;
  }

  // Combine text and region annotations
  const items: string[] = [];

  for (const a of textAnnotations) {
    items.push(`
      <div class="annotation-item" data-id="${a.id}" data-type="text">
        <span class="type-indicator ${a.type}"></span>
        <span class="annotation-text" title="${escapeHtml(a.selectedText)}">${escapeHtml(a.selectedText.substring(0, 40))}${a.selectedText.length > 40 ? '...' : ''}</span>
        <button class="annotation-delete" data-id="${a.id}" title="Delete">×</button>
      </div>
    `);
  }

  for (const a of regionAnnotations) {
    items.push(`
      <div class="annotation-item" data-id="${a.id}" data-type="region">
        <span class="type-indicator ${a.type}"></span>
        <span class="annotation-text">[Region: ${a.bounds.width.toFixed(0)}×${a.bounds.height.toFixed(0)}]</span>
        <button class="annotation-delete" data-id="${a.id}" title="Delete">×</button>
      </div>
    `);
  }

  listEl.innerHTML = items.join('');

  // Add click handlers to scroll to annotation
  listEl.querySelectorAll('.annotation-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('annotation-delete')) return;
      const id = (item as HTMLElement).dataset.id;
      if (id) {
        listEl.querySelectorAll('.annotation-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        scrollToAnnotation(id);
      }
    });
  });

  // Add delete handlers
  listEl.querySelectorAll('.annotation-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      const type = (btn.parentElement as HTMLElement).dataset.type;
      if (id) deleteAnnotation(id, type as 'text' | 'region');
    });
  });
}

// Delete annotation
function deleteAnnotation(id: string, type: 'text' | 'region') {
  if (!currentSnapshot) return;

  if (type === 'text') {
    currentSnapshot.annotations.text = currentSnapshot.annotations.text.filter(a => a.id !== id);
    // Also remove from text annotator
    if (textAnnotator) {
      try {
        textAnnotator.removeAnnotation(id);
      } catch (e) {
        // Ignore if annotation not found in annotator
      }
    }
  } else {
    currentSnapshot.annotations.region = currentSnapshot.annotations.region.filter(a => a.id !== id);
    // Also remove from image annotators
    imageAnnotators.forEach(annotator => {
      try {
        annotator.removeAnnotation(id);
      } catch (e) {
        // Ignore
      }
    });
  }

  // Remove from questions
  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter(aid => aid !== id);
  }

  updateAnnotationCounts();
  renderAnnotationList();
  saveCurrentSnapshot();
}

// Update status display
function updateStatusDisplay() {
  if (!currentSnapshot) return;

  const statusEl = document.getElementById('current-status');
  if (statusEl) {
    statusEl.innerHTML = `<span class="status-badge ${currentSnapshot.status}">${currentSnapshot.status}</span>`;
  }
}

// Update evaluation form
function updateEvaluationForm() {
  // Clear all radios first
  document.querySelectorAll('input[name="correctness"]').forEach((r) => (r as HTMLInputElement).checked = false);
  document.querySelectorAll('input[name="in-page"]').forEach((r) => (r as HTMLInputElement).checked = false);
  document.querySelectorAll('input[name="quality"]').forEach((r) => (r as HTMLInputElement).checked = false);

  if (!currentSnapshot || !currentQuestionId) return;

  const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
  if (!question) return;

  // Set radio values
  if (question.evaluation.answerCorrectness) {
    const radio = document.querySelector(
      `input[name="correctness"][value="${question.evaluation.answerCorrectness}"]`
    ) as HTMLInputElement;
    if (radio) radio.checked = true;
  }

  if (question.evaluation.answerInPage) {
    const radio = document.querySelector(
      `input[name="in-page"][value="${question.evaluation.answerInPage}"]`
    ) as HTMLInputElement;
    if (radio) radio.checked = true;
  }

  if (question.evaluation.pageQuality) {
    const radio = document.querySelector(
      `input[name="quality"][value="${question.evaluation.pageQuality}"]`
    ) as HTMLInputElement;
    if (radio) radio.checked = true;
  }
}

// Save current snapshot (silent by default, showNotification for explicit saves)
async function saveCurrentSnapshot(showConfirmation = false) {
  if (!currentSnapshot) return;

  currentSnapshot.updatedAt = new Date().toISOString();

  try {
    await sendMessage('UPDATE_SNAPSHOT', {
      id: currentSnapshot.id,
      updates: currentSnapshot,
    });
    if (showConfirmation) {
      showNotification('Saved');
    }
  } catch (error) {
    console.error('Failed to save snapshot:', error);
    showNotification('Save failed', 'error');
  }
}

// Show notification
function showNotification(message: string, type: 'success' | 'error' = 'success') {
  let container = document.getElementById('notification-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notification-container';
    container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 10000;';
    document.body.appendChild(container);
  }

  const notification = document.createElement('div');
  notification.style.cssText = `
    padding: 12px 20px;
    margin-bottom: 8px;
    border-radius: 6px;
    color: white;
    font-size: 14px;
    background: ${type === 'success' ? '#059669' : '#dc2626'};
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    animation: slideIn 0.3s ease;
  `;
  notification.textContent = message;
  container.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s';
    setTimeout(() => notification.remove(), 300);
  }, 2000);
}

// Load all snapshots for navigation (direct storage access - no message size limits)
async function loadAllSnapshots(filter: string = 'all') {
  try {
    const snapshots = await getAllSnapshotSummaries();
    allSnapshots = snapshots;

    let filtered = snapshots;
    if (filter === 'pending') {
      filtered = snapshots.filter(s => s.status === 'pending');
    } else if (filter === 'approved') {
      filtered = snapshots.filter(s => s.status === 'approved' || s.status === 'declined');
    }

    renderSnapshotNav(filtered);
  } catch (error) {
    console.error('Failed to load snapshots:', error);
  }
}

// Render snapshot navigation
function renderSnapshotNav(snapshots: SnapshotSummary[]) {
  const navEl = document.getElementById('snapshot-nav');
  if (!navEl) return;

  if (snapshots.length === 0) {
    navEl.innerHTML = '<li class="empty-state">No snapshots found</li>';
    return;
  }

  navEl.innerHTML = snapshots
    .map(
      (s) => `
      <li data-id="${s.id}" class="${currentSnapshot?.id === s.id ? 'active' : ''}">
        <div class="nav-item-content">
          <div class="nav-item-title">${escapeHtml(s.title || 'Untitled')}</div>
          <div class="nav-item-meta">
            <span>${formatDate(s.capturedAt)}</span>
            <span class="status-badge ${s.status}">${s.status}</span>
          </div>
        </div>
        <button class="nav-item-delete" data-id="${s.id}" title="Delete snapshot">×</button>
      </li>
    `
    )
    .join('');

  // Add click handlers for navigation
  navEl.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('nav-item-delete')) return;
      const id = (li as HTMLElement).dataset.id;
      if (id) {
        window.history.pushState({}, '', `?id=${id}`);
        loadSnapshot(id);
      }
    });
  });

  // Add click handlers for delete buttons
  navEl.querySelectorAll('.nav-item-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      if (id) {
        const snapshot = allSnapshots.find(s => s.id === id);
        const title = snapshot?.title || 'Untitled';
        if (confirm(`Delete snapshot "${title}"?\n\nThis cannot be undone.`)) {
          await deleteSnapshotById(id);
        }
      }
    });
  });
}

// Delete a snapshot by ID
async function deleteSnapshotById(id: string) {
  try {
    await sendMessage('DELETE_SNAPSHOT', { id });
    showNotification('Snapshot deleted');

    if (currentSnapshot?.id === id) {
      destroyAnnotators();
      currentSnapshot = null;
      const remaining = allSnapshots.filter(s => s.id !== id);
      if (remaining.length > 0) {
        await loadSnapshot(remaining[0].id);
      } else {
        const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
        if (iframe) iframe.src = 'about:blank';
        const titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.textContent = 'No snapshots';
      }
    }

    await loadAllSnapshots();
  } catch (error) {
    console.error('Failed to delete snapshot:', error);
    showNotification('Failed to delete snapshot', 'error');
  }
}

// Update active state in snapshot nav
function updateSnapshotNavActive() {
  const navEl = document.getElementById('snapshot-nav');
  if (!navEl || !currentSnapshot) return;

  navEl.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('active', li.dataset.id === currentSnapshot?.id);
  });
}

// Format date
function formatDate(date: string): string {
  return new Date(date).toLocaleDateString();
}

// Escape HTML
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Add new question
function addQuestion() {
  if (!currentSnapshot) return;

  const question: Question = {
    id: generateId(),
    query: '',
    expectedAnswer: '',
    annotationIds: [],
    evaluation: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  currentSnapshot.questions.push(question);
  currentQuestionId = question.id;

  updateQuestionSelector();
  const select = document.getElementById('question-select') as HTMLSelectElement;
  if (select) select.value = question.id;

  clearQuestionForm();
  saveCurrentSnapshot();

  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  queryInput?.focus();
}

// Set tool
function setTool(tool: 'select' | AnnotationType) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
  btn?.classList.add('active');

  // Update image annotator enabled state
  imageAnnotators.forEach(annotator => {
    annotator.setDrawingEnabled(tool !== 'select');
  });

  // Notify iframe annotator of tool change
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    sendToIframe(iframe, 'SET_TOOL', tool);
  }
}

// Set evaluation value
function setEvaluationValue(name: string, value: string) {
  if (!currentSnapshot || !currentQuestionId) return;
  const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
  if (!question) return;

  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement;
  if (radio) {
    radio.checked = true;

    if (name === 'correctness') {
      question.evaluation.answerCorrectness = value as AnswerCorrectness;
    } else if (name === 'in-page') {
      question.evaluation.answerInPage = value as AnswerInPage;
    } else if (name === 'quality') {
      question.evaluation.pageQuality = value as PageQuality;
    }

    saveCurrentSnapshot();
  }
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' ||
        (e.target as HTMLElement).tagName === 'TEXTAREA' ||
        (e.target as HTMLElement).tagName === 'SELECT') {
      return;
    }

    // Annotation tools
    if (e.key === '1' || e.key === 'r') {
      e.preventDefault();
      setTool('relevant');
    } else if (e.key === '2' || e.key === 'a') {
      e.preventDefault();
      setTool('answer');
    } else if (e.key === 'Escape' || e.key === '0' || e.key === 's') {
      e.preventDefault();
      setTool('select');
    }

    // Evaluation shortcuts
    if (currentQuestionId) {
      if (e.key === 'c') {
        e.preventDefault();
        setEvaluationValue('correctness', 'correct');
      } else if (e.key === 'i') {
        e.preventDefault();
        setEvaluationValue('correctness', 'incorrect');
      } else if (e.key === 'p') {
        e.preventDefault();
        setEvaluationValue('correctness', 'partial');
      }

      if (e.key === 'y') {
        e.preventDefault();
        setEvaluationValue('in-page', 'yes');
      } else if (e.key === 'n') {
        e.preventDefault();
        setEvaluationValue('in-page', 'no');
      }

      if (e.key === 'g') {
        e.preventDefault();
        setEvaluationValue('quality', 'good');
      } else if (e.key === 'b') {
        e.preventDefault();
        setEvaluationValue('quality', 'broken');
      }
    }

    // Other shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') {
        e.preventDefault();
        saveCurrentSnapshot(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentSnapshot) {
          currentSnapshot.status = 'approved';
          updateStatusDisplay();
          saveCurrentSnapshot();
          loadAllSnapshots();
          const nextPending = allSnapshots.find(s => s.status === 'pending' && s.id !== currentSnapshot?.id);
          if (nextPending) {
            loadSnapshot(nextPending.id);
          }
        }
      }
    }

    // Zoom
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomLevel = Math.min(200, zoomLevel + 10);
      applyZoom();
    } else if (e.key === '-') {
      e.preventDefault();
      zoomLevel = Math.max(50, zoomLevel - 10);
      applyZoom();
    }
  });
}

// Apply zoom level
function applyZoom() {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  const zoomEl = document.getElementById('zoom-level');

  if (iframe) {
    iframe.style.transform = `scale(${zoomLevel / 100})`;
    iframe.style.width = `${10000 / zoomLevel}%`;
    iframe.style.height = `${10000 / zoomLevel}%`;
  }

  if (zoomEl) {
    zoomEl.textContent = `${zoomLevel}%`;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const params = getUrlParams();
  const snapshotId = params.get('id');

  setupKeyboardShortcuts();

  await loadAllSnapshots();

  if (snapshotId) {
    await loadSnapshot(snapshotId);
  } else if (allSnapshots.length > 0) {
    await loadSnapshot(allSnapshots[0].id);
  }

  // Tool buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setTool((btn as HTMLElement).dataset.tool as typeof currentTool);
    });
  });

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = (tab as HTMLElement).dataset.filter || 'all';
      loadAllSnapshots(filter);
    });
  });

  // Question selector
  const questionSelect = document.getElementById('question-select') as HTMLSelectElement;
  questionSelect?.addEventListener('change', () => {
    currentQuestionId = questionSelect.value || null;
    updateQuestionForm();
    updateEvaluationForm();
  });

  // Add question button
  document.getElementById('add-question-btn')?.addEventListener('click', addQuestion);

  // Query input
  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  queryInput?.addEventListener('input', () => {
    if (!currentSnapshot || !currentQuestionId) return;
    const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
    if (question) {
      question.query = queryInput.value;
      question.updatedAt = new Date().toISOString();
      updateQuestionSelector();
      saveCurrentSnapshot();
    }
  });

  // Expected answer input
  const answerInput = document.getElementById('expected-answer') as HTMLTextAreaElement;
  answerInput?.addEventListener('input', () => {
    if (!currentSnapshot || !currentQuestionId) return;
    const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
    if (question) {
      question.expectedAnswer = answerInput.value;
      question.updatedAt = new Date().toISOString();
      saveCurrentSnapshot();
    }
  });

  // Evaluation radios
  document.querySelectorAll('input[name="correctness"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!currentSnapshot || !currentQuestionId) return;
      const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
      if (question) {
        question.evaluation.answerCorrectness = (radio as HTMLInputElement).value as AnswerCorrectness;
        saveCurrentSnapshot();
      }
    });
  });

  document.querySelectorAll('input[name="in-page"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!currentSnapshot || !currentQuestionId) return;
      const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
      if (question) {
        question.evaluation.answerInPage = (radio as HTMLInputElement).value as AnswerInPage;
        saveCurrentSnapshot();
      }
    });
  });

  document.querySelectorAll('input[name="quality"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!currentSnapshot || !currentQuestionId) return;
      const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
      if (question) {
        question.evaluation.pageQuality = (radio as HTMLInputElement).value as PageQuality;
        saveCurrentSnapshot();
      }
    });
  });

  // Zoom controls
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    zoomLevel = Math.min(200, zoomLevel + 10);
    applyZoom();
  });

  document.getElementById('zoom-out')?.addEventListener('click', () => {
    zoomLevel = Math.max(50, zoomLevel - 10);
    applyZoom();
  });

  // Approve/Decline buttons
  document.getElementById('approve-btn')?.addEventListener('click', () => {
    if (currentSnapshot) {
      currentSnapshot.status = 'approved';
      updateStatusDisplay();
      saveCurrentSnapshot();
      loadAllSnapshots();
    }
  });

  document.getElementById('decline-btn')?.addEventListener('click', () => {
    if (currentSnapshot) {
      currentSnapshot.status = 'declined';
      updateStatusDisplay();
      saveCurrentSnapshot();
      loadAllSnapshots();
    }
  });

  // Review notes
  const notesInput = document.getElementById('review-notes') as HTMLTextAreaElement;
  notesInput?.addEventListener('input', () => {
    if (currentSnapshot) {
      currentSnapshot.reviewNotes = notesInput.value;
      saveCurrentSnapshot();
    }
  });

  // Save button
  document.getElementById('save-btn')?.addEventListener('click', () => saveCurrentSnapshot(true));

  // Submit button
  document.getElementById('submit-btn')?.addEventListener('click', () => saveCurrentSnapshot(true));

  // Back button
  document.getElementById('back-btn')?.addEventListener('click', () => {
    window.close();
  });
});
