/**
 * Annotator script that runs inside the iframe context
 * This allows Recogito and Annotorious to properly detect text and image selections
 */

import { createTextAnnotator } from '@recogito/text-annotator';
import { createImageAnnotator } from '@annotorious/annotorious';
import '@recogito/text-annotator/text-annotator.css';
import '@annotorious/annotorious/annotorious.css';

// Types for messages
interface AnnotatorMessage {
  type: string;
  payload?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let annotator: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const imageAnnotators: Map<string, any> = new Map();
let currentTool: 'select' | 'relevant' | 'answer' = 'select';
let annotationIndex = 0; // Track annotation numbers
let regionAnnotationIndex = 0; // Track region annotation numbers

// Flag to suppress delete events during clear operations (e.g., switching questions)
let suppressDeleteEvents = false;

// Store annotation metadata for re-applying styles after Recogito re-renders
const annotationMeta: Map<string, { tool: string; index: number }> = new Map();

// Store annotation text for scrolling to off-screen annotations
const annotationText: Map<string, string> = new Map();

// Color mapping for annotation types
const ANNOTATION_COLORS: Record<string, string> = {
  relevant: 'rgba(34, 197, 94, 0.4)',  // green
  answer: 'rgba(59, 130, 246, 0.4)',    // blue
};

// Block-level elements that should have space/newline between them
const BLOCK_ELEMENTS = new Set([
  'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'PRE',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV',
  'ASIDE', 'MAIN', 'FIGURE', 'FIGCAPTION', 'DT', 'DD'
]);

// Get normalized text from current selection, adding spaces at element boundaries
function getNormalizedSelectionText(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;

  // Create a document fragment to walk through
  const fragment = range.cloneContents();

  // Walk through all text nodes and track their parent elements
  const textParts: { text: string; isBlock: boolean }[] = [];

  function walkNodes(node: Node, isFirstInBlock: boolean = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text.trim()) {
        textParts.push({ text: text, isBlock: isFirstInBlock });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const isBlock = BLOCK_ELEMENTS.has(el.tagName);

      let first = true;
      for (const child of Array.from(node.childNodes)) {
        walkNodes(child, isBlock && first);
        first = false;
      }
    }
  }

  walkNodes(fragment);

  if (textParts.length === 0) return null;

  // Build normalized text with spaces between elements
  let result = '';
  let prevEndsWithSpace = true;

  for (let i = 0; i < textParts.length; i++) {
    const part = textParts[i];
    const text = part.text;

    // Add space between parts if:
    // 1. Previous part didn't end with space and current doesn't start with space
    // 2. This is a new block element
    if (i > 0) {
      const needsSpace = !prevEndsWithSpace && !/^\s/.test(text);
      if (needsSpace || part.isBlock) {
        result += ' ';
      }
    }

    result += text;
    prevEndsWithSpace = /\s$/.test(text);
  }

  // Clean up multiple spaces
  return result.replace(/\s+/g, ' ').trim();
}

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
  const borderColor = tool === 'answer' ? 'rgb(59, 130, 246)' : 'rgb(34, 197, 94)';
  // Recogito uses data attributes on highlight spans
  const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
  elements.forEach((el, i) => {
    const htmlEl = el as HTMLElement;
    // Apply inline styles with highest priority
    htmlEl.style.setProperty('background-color', color, 'important');
    htmlEl.style.setProperty('background', color, 'important');
    htmlEl.style.setProperty('border-bottom', `2px solid ${borderColor}`, 'important');
    htmlEl.style.setProperty('opacity', '1', 'important');
    htmlEl.style.setProperty('visibility', 'visible', 'important');
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
      const borderColor = meta.tool === 'answer' ? 'rgb(59, 130, 246)' : 'rgb(34, 197, 94)';
      elements.forEach((el, i) => {
        const htmlEl = el as HTMLElement;
        // Always re-apply inline styles to override any page CSS
        htmlEl.style.setProperty('background-color', color, 'important');
        htmlEl.style.setProperty('background', color, 'important');
        htmlEl.style.setProperty('border-bottom', `2px solid ${borderColor}`, 'important');
        htmlEl.style.setProperty('opacity', '1', 'important');
        htmlEl.style.setProperty('visibility', 'visible', 'important');
        el.classList.add(`annotation-${meta.tool}`);
        if (i === 0) {
          el.setAttribute('data-annotation-index', String(meta.index));
          el.classList.add('has-index');
        }
      });
    }
  });
}

// Apply custom styling to region (image) annotations
function applyRegionAnnotationStyle(annotationId: string, tool: string) {
  // Annotorious uses SVG elements with data-annotation attribute
  setTimeout(() => {
    // Find annotation elements by data attribute
    const elements = document.querySelectorAll(`[data-annotation="${annotationId}"], g[data-id="${annotationId}"]`);

    if (elements.length === 0) {
      // Try finding in the SVG layer - Annotorious uses g elements with the annotation ID
      const allGroups = document.querySelectorAll('.a9s-annotationlayer g');
      allGroups.forEach(g => {
        // Check if this group's annotation matches
        const dataId = g.getAttribute('data-id') || g.id;
        if (dataId === annotationId) {
          g.classList.add('a9s-annotation', `annotation-${tool}`);
          console.log('[Iframe Annotator] Applied style to region annotation via group search:', annotationId);
        }
      });
    } else {
      elements.forEach(el => {
        el.classList.add(`annotation-${tool}`);
      });
      console.log('[Iframe Annotator] Applied style to region annotation:', annotationId, 'tool:', tool);
    }
  }, 50);
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

    // Get normalized text before selection is cleared (adds spaces at element boundaries)
    const normalizedText = getNormalizedSelectionText();

    // Serialize to remove non-cloneable objects
    const serialized = serializeAnnotation(annotation) as {
      target?: {
        selector?: Array<{ quote?: string }>;
      };
    };
    const ann = annotation as { id?: string };

    // Replace the raw text with normalized text if available
    if (normalizedText && serialized.target?.selector?.[0]) {
      console.log('[Iframe Annotator] Replacing raw text with normalized:', normalizedText);
      serialized.target.selector[0].quote = normalizedText;
    }

    // Store text for scroll functionality
    if (ann.id && serialized.target?.selector?.[0]?.quote) {
      annotationText.set(ann.id, serialized.target.selector[0].quote);
    }

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
    // Don't send delete events during clear operations (e.g., switching questions)
    if (suppressDeleteEvents) {
      console.log('[Iframe Annotator] Annotation delete suppressed (clearing):', annotation);
      return;
    }

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

// Initialize image annotators for all images in the container
function initializeImageAnnotators(container: HTMLElement) {
  console.log('[Iframe Annotator] Initializing image annotators');

  // Destroy existing image annotators
  imageAnnotators.forEach(ann => {
    try {
      ann.destroy();
    } catch (e) {
      console.warn('[Iframe Annotator] Error destroying image annotator:', e);
    }
  });
  imageAnnotators.clear();
  regionAnnotationIndex = 0;

  const images = container.querySelectorAll('img');
  console.log('[Iframe Annotator] Found', images.length, 'images');

  images.forEach((img, index) => {
    // Skip tiny images (icons, etc.)
    if (img.naturalWidth < 100 || img.naturalHeight < 100) {
      console.log('[Iframe Annotator] Skipping small image:', img.src?.substring(0, 50));
      return;
    }

    // Disable default drag behavior on the image
    img.draggable = false;
    img.addEventListener('dragstart', (e) => e.preventDefault());

    try {
      const imgId = img.id || `img-${index}`;
      img.id = imgId;

      // Capture original dimensions and display style before Annotorious wraps
      const rect = img.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(img);
      const originalWidth = rect.width;
      const originalHeight = rect.height;
      const originalDisplay = computedStyle.display;

      // Store original parent for reference
      const originalParent = img.parentElement;

      const imageAnnotator = createImageAnnotator(img, {
        drawingEnabled: currentTool !== 'select',
      });

      // Check if Annotorious wrapped the image and if dimensions collapsed
      const wrapper = img.parentElement;
      if (wrapper && wrapper !== originalParent) {
        const wrapperRect = wrapper.getBoundingClientRect();

        // Only apply explicit dimensions if the wrapper collapsed (much smaller than original)
        const collapsed = wrapperRect.width < originalWidth * 0.5 || wrapperRect.height < originalHeight * 0.5;

        if (collapsed && originalWidth > 0 && originalHeight > 0) {
          console.log('[Iframe Annotator] Fixing collapsed wrapper for:', imgId, 'original:', originalWidth, 'x', originalHeight);
          wrapper.style.cssText = `
            display: ${originalDisplay === 'inline' ? 'inline-block' : originalDisplay} !important;
            width: ${originalWidth}px !important;
            height: ${originalHeight}px !important;
            position: relative !important;
            max-width: 100% !important;
          `;
          img.style.cssText = `
            width: 100% !important;
            height: 100% !important;
            object-fit: contain !important;
            display: block !important;
          `;
        } else {
          // Just ensure the wrapper has position relative for the annotation layer
          wrapper.style.position = 'relative';
        }
      }

      // Handle region annotation creation
      imageAnnotator.on('createAnnotation', (annotation: unknown) => {
        if (currentTool === 'select') return;

        console.log('[Iframe Annotator] Region annotation created (raw):', JSON.stringify(annotation, null, 2));

        const ann = annotation as { id?: string; target?: unknown };
        regionAnnotationIndex++;

        // Apply styling to the annotation element
        if (ann.id) {
          applyRegionAnnotationStyle(ann.id, currentTool);
        }

        const serialized = serializeAnnotation(annotation);
        console.log('[Iframe Annotator] Region annotation serialized:', JSON.stringify(serialized, null, 2));

        window.parent.postMessage({
          type: 'REGION_ANNOTATION_CREATED',
          payload: {
            annotation: serialized,
            tool: currentTool,
            imageId: imgId,
            index: regionAnnotationIndex
          }
        }, '*');
      });

      // Handle region annotation deletion
      imageAnnotator.on('deleteAnnotation', (annotation: unknown) => {
        // Don't send delete events during clear operations (e.g., switching questions)
        if (suppressDeleteEvents) {
          console.log('[Iframe Annotator] Region annotation delete suppressed (clearing):', annotation);
          return;
        }

        console.log('[Iframe Annotator] Region annotation deleted:', annotation);

        const serialized = serializeAnnotation(annotation);

        window.parent.postMessage({
          type: 'REGION_ANNOTATION_DELETED',
          payload: { annotation: serialized, imageId: imgId }
        }, '*');
      });

      // Handle region annotation click
      imageAnnotator.on('clickAnnotation', (annotation: unknown) => {
        console.log('[Iframe Annotator] Region annotation clicked:', annotation);
        const ann = annotation as { id?: string };
        if (ann.id) {
          window.parent.postMessage({
            type: 'ANNOTATION_CLICKED',
            payload: { annotationId: ann.id }
          }, '*');
        }
      });

      imageAnnotators.set(imgId, imageAnnotator);
      console.log('[Iframe Annotator] Created image annotator for:', imgId);
    } catch (error) {
      console.warn('[Iframe Annotator] Failed to initialize image annotator:', error);
    }
  });

  console.log('[Iframe Annotator] Initialized', imageAnnotators.size, 'image annotators');
}

// Update drawing enabled state for all image annotators
function updateImageAnnotatorsEnabled(enabled: boolean) {
  imageAnnotators.forEach(ann => {
    try {
      ann.setDrawingEnabled(enabled);
    } catch (e) {
      console.warn('[Iframe Annotator] Error setting drawing enabled:', e);
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

      // Get the first annotation element's position
      const firstEl = elements[0] as HTMLElement;
      const topStyle = firstEl.style.top;

      if (topStyle) {
        // Parse the top value (e.g., "602.453px" -> 602.453)
        const topValue = parseFloat(topStyle);
        if (!isNaN(topValue)) {
          // Scroll the document to center the annotation
          const viewportHeight = window.innerHeight;
          const scrollTarget = Math.max(0, topValue - viewportHeight / 2 + 50);

          // Try multiple scroll targets for compatibility
          document.documentElement.scrollTop = scrollTarget;
          document.body.scrollTop = scrollTarget;
          window.scrollTo({
            top: scrollTarget,
            behavior: 'smooth'
          });
          console.log('[Iframe Annotator] Scrolling to position:', scrollTarget);
          return;
        }
      }

      // Fallback to scrollIntoView if position parsing fails
      firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  }

  // DOM elements don't exist (annotation is off-screen) - search for text instead
  const searchText = annotationText.get(annotationId);
  console.log('[Iframe Annotator] Text stored for annotation:', annotationId, '=', searchText?.substring(0, 50));

  if (searchText) {
    console.log('[Iframe Annotator] Searching for text in document:', searchText.substring(0, 50));
    const textNode = findTextInDocument(searchText);
    console.log('[Iframe Annotator] Text node found:', !!textNode);

    if (textNode) {
      // Create a range and scroll to it
      const range = document.createRange();
      range.selectNodeContents(textNode.node);
      const rect = range.getBoundingClientRect();
      const scrollTarget = window.scrollY + rect.top - window.innerHeight / 2;

      console.log('[Iframe Annotator] Scrolling to text at:', scrollTarget, 'rect.top:', rect.top);
      document.documentElement.scrollTop = scrollTarget;
      document.body.scrollTop = scrollTarget;
      window.scrollTo({
        top: Math.max(0, scrollTarget),
        behavior: 'smooth'
      });
      console.log('[Iframe Annotator] Scrolled to text at:', scrollTarget);
      return;
    }
  }

  console.log('[Iframe Annotator] No elements found for annotation:', annotationId);
}

// Find text content in the document
function findTextInDocument(searchText: string): { node: Node; offset: number } | null {
  // Normalize the search text - collapse whitespace
  const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();

  // Try different search strategies
  const searchStrategies = [
    normalizedSearch,                           // Full normalized text
    normalizedSearch.substring(0, 50),          // First 50 chars
    normalizedSearch.substring(0, 30),          // First 30 chars
    normalizedSearch.split(' ').slice(0, 5).join(' '), // First 5 words
  ];

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  // Build a map of text content for searching
  const textNodes: Array<{ node: Node; text: string; normalizedText: string }> = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    if (text.trim()) {
      textNodes.push({
        node,
        text,
        normalizedText: text.replace(/\s+/g, ' ')
      });
    }
  }

  // Try each search strategy
  for (const searchStr of searchStrategies) {
    if (!searchStr || searchStr.length < 5) continue;

    for (const { node, text, normalizedText } of textNodes) {
      // Try exact match
      let index = text.indexOf(searchStr);
      if (index !== -1) {
        console.log('[Iframe Annotator] Found exact match for:', searchStr.substring(0, 30));
        return { node, offset: index };
      }

      // Try normalized match
      index = normalizedText.indexOf(searchStr);
      if (index !== -1) {
        console.log('[Iframe Annotator] Found normalized match for:', searchStr.substring(0, 30));
        return { node, offset: index };
      }

      // Try case-insensitive match
      index = normalizedText.toLowerCase().indexOf(searchStr.toLowerCase());
      if (index !== -1) {
        console.log('[Iframe Annotator] Found case-insensitive match for:', searchStr.substring(0, 30));
        return { node, offset: index };
      }
    }
  }

  console.log('[Iframe Annotator] No text match found for any strategy');
  return null;
}

// Inject custom styles for annotation colors
function injectAnnotationStyles() {
  if (document.getElementById('pl-annotation-styles')) return;

  const style = document.createElement('style');
  style.id = 'pl-annotation-styles';
  // Use very high specificity selectors to override page styles
  style.textContent = `
    /* CRITICAL: Fix the highlight layer - disable mix-blend-mode which causes visibility issues */
    .r6o-span-highlight-layer {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      min-height: 100% !important;
      height: auto !important;
      pointer-events: none !important;
      z-index: 2147483640 !important;
      overflow: visible !important;
      mix-blend-mode: normal !important;
      isolation: isolate !important;
      opacity: 1 !important;
      visibility: visible !important;
      clip: auto !important;
      clip-path: none !important;
    }

    /* Ensure the annotatable container has proper positioning and doesn't clip */
    .r6o-annotatable {
      position: relative !important;
      overflow: visible !important;
      clip: auto !important;
      clip-path: none !important;
    }

    /* Make annotation spans visible with high z-index */
    .r6o-span-highlight-layer .r6o-annotation,
    .r6o-annotation {
      position: absolute !important;
      pointer-events: auto !important;
      overflow: visible !important;
      z-index: 2147483641 !important;
      mix-blend-mode: normal !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Custom annotation colors for relevant (green) */
    .r6o-annotation.annotation-relevant,
    [data-annotation].annotation-relevant {
      background-color: rgba(34, 197, 94, 0.5) !important;
      background: rgba(34, 197, 94, 0.5) !important;
      border-bottom: 2px solid rgb(34, 197, 94) !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Custom annotation colors for answer (blue) */
    .r6o-annotation.annotation-answer,
    [data-annotation].annotation-answer {
      background-color: rgba(59, 130, 246, 0.5) !important;
      background: rgba(59, 130, 246, 0.5) !important;
      border-bottom: 2px solid rgb(59, 130, 246) !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Number badge for annotations */
    .has-index {
      overflow: visible !important;
    }
    .has-index::before {
      content: attr(data-annotation-index) !important;
      position: absolute !important;
      top: -12px !important;
      left: -6px !important;
      background: #374151 !important;
      color: white !important;
      font-size: 10px !important;
      font-weight: bold !important;
      min-width: 16px !important;
      height: 16px !important;
      line-height: 16px !important;
      text-align: center !important;
      border-radius: 8px !important;
      padding: 0 4px !important;
      z-index: 2147483647 !important;
      font-family: system-ui, -apple-system, sans-serif !important;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4) !important;
      pointer-events: none !important;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .has-index.annotation-relevant::before {
      background: rgb(22, 163, 74) !important;
    }
    .has-index.annotation-answer::before {
      background: rgb(37, 99, 235) !important;
    }

    /* Hover effect on annotations */
    .r6o-annotation:hover,
    [data-annotation]:hover {
      filter: brightness(0.85) !important;
      box-shadow: 0 0 0 2px rgba(0,0,0,0.15) !important;
      cursor: pointer !important;
    }

    /* Selected annotation */
    .r6o-annotation.selected,
    .r6o-annotation.pl-selected,
    [data-annotation].selected,
    [data-annotation].pl-selected {
      outline: 3px solid #f59e0b !important;
      outline-offset: 1px !important;
    }
    .has-index.selected::before,
    .has-index.pl-selected::before {
      background: #f59e0b !important;
    }

    /* ========================================
       Annotorious (Image Annotation) Styles
       ======================================== */

    /* Annotorious layer container */
    .a9s-annotationlayer {
      pointer-events: auto !important;
      z-index: 100 !important;
    }

    /* Default annotation shape styling */
    .a9s-annotation .a9s-inner {
      fill: rgba(34, 197, 94, 0.2) !important;
      stroke: rgb(34, 197, 94) !important;
      stroke-width: 2px !important;
    }

    /* Relevant annotation (green) */
    .a9s-annotation.annotation-relevant .a9s-inner {
      fill: rgba(34, 197, 94, 0.25) !important;
      stroke: rgb(34, 197, 94) !important;
      stroke-width: 2px !important;
    }

    /* Answer annotation (blue) */
    .a9s-annotation.annotation-answer .a9s-inner {
      fill: rgba(59, 130, 246, 0.25) !important;
      stroke: rgb(59, 130, 246) !important;
      stroke-width: 2px !important;
    }

    /* Hover effect on image annotations */
    .a9s-annotation:hover .a9s-inner {
      stroke-width: 3px !important;
      filter: brightness(0.9) !important;
    }

    /* Selected image annotation */
    .a9s-annotation.selected .a9s-inner,
    .a9s-annotation.a9s-selected .a9s-inner {
      stroke: #f59e0b !important;
      stroke-width: 3px !important;
    }

    /* Drawing/creation mode */
    .a9s-annotation.a9s-drawing .a9s-inner {
      stroke-dasharray: 5, 5 !important;
    }

    /* Disable image dragging to allow region selection */
    img {
      -webkit-user-drag: none !important;
      -khtml-user-drag: none !important;
      -moz-user-drag: none !important;
      -o-user-drag: none !important;
      user-drag: none !important;
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

        // Initialize image annotators after a brief delay to allow images to load
        // Send ANNOTATOR_READY only after both text and image annotators are ready
        setTimeout(() => {
          initializeImageAnnotators(container);
          // Signal ready after all annotators are initialized
          window.parent.postMessage({ type: 'ANNOTATOR_READY' }, '*');
        }, 100);
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
      // Also update image annotators
      updateImageAnnotatorsEnabled(currentTool !== 'select');
      break;

    case 'LOAD_ANNOTATIONS':
      if (annotator) {
        const annotations = message.payload as Array<{
          id?: string;
          bodies?: Array<{ value?: string }>;
          target?: { selector?: Array<{ quote?: string }> };
        }>;
        console.log('[Iframe Annotator] LOAD_ANNOTATIONS received:', annotations);
        if (annotations?.length) {
          // Reset annotation index and set to count of loaded annotations
          annotationIndex = annotations.length;

          // Store annotation text for scroll functionality
          annotations.forEach(ann => {
            if (ann.id && ann.target?.selector?.[0]?.quote) {
              annotationText.set(ann.id, ann.target.selector[0].quote);
            }
          });

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
        // Suppress delete events during clear (we're just switching questions, not deleting data)
        suppressDeleteEvents = true;
        annotator.clearAnnotations();
        suppressDeleteEvents = false;
        // Also clear metadata, text, and reset index
        annotationMeta.clear();
        annotationText.clear();
        annotationIndex = 0;
      }
      break;

    case 'SCROLL_TO_ANNOTATION': {
      const { annotationId } = message.payload as { annotationId: string };
      if (annotationId) {
        highlightAnnotation(annotationId);
      }
      break;
    }

    case 'REMOVE_ANNOTATION': {
      const { annotationId } = message.payload as { annotationId: string };
      if (annotationId) {
        // Try to remove via annotator API
        if (annotator) {
          try {
            annotator.removeAnnotation(annotationId);
            console.log('[Iframe Annotator] Removed annotation via API:', annotationId);
          } catch (e) {
            console.warn('[Iframe Annotator] Error removing annotation via API:', e);
          }
        }

        // Also manually remove DOM elements as fallback
        const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
        elements.forEach(el => {
          // Unwrap the highlight span - move children out and remove the span
          const parent = el.parentNode;
          if (parent) {
            while (el.firstChild) {
              parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
          }
        });
        if (elements.length > 0) {
          console.log('[Iframe Annotator] Manually removed', elements.length, 'DOM elements for:', annotationId);
        }

        // Clean up metadata
        annotationMeta.delete(annotationId);
        annotationText.delete(annotationId);
      }
      break;
    }

    case 'LOAD_REGION_ANNOTATIONS': {
      const regionAnnotations = message.payload as Array<{
        id?: string;
        imageId: string;
        bounds: { x: number; y: number; width: number; height: number };
        type?: string;
      }>;
      console.log('[Iframe Annotator] LOAD_REGION_ANNOTATIONS received:', regionAnnotations);
      console.log('[Iframe Annotator] Available image annotators:', Array.from(imageAnnotators.keys()));

      if (regionAnnotations?.length) {
        regionAnnotationIndex = regionAnnotations.length;

        regionAnnotations.forEach(ann => {
          const imageAnnotator = imageAnnotators.get(ann.imageId);
          if (!imageAnnotator) {
            console.warn('[Iframe Annotator] No image annotator found for:', ann.imageId);
            return;
          }
          if (ann.id) {
            try {
              // Create annotation in Annotorious native format (RECTANGLE)
              const annotoriousAnnotation = {
                id: ann.id,
                bodies: [{
                  type: 'TextualBody',
                  purpose: 'tagging',
                  value: ann.type || 'relevant',
                }],
                target: {
                  annotation: ann.id,
                  selector: {
                    type: 'RECTANGLE',
                    geometry: {
                      x: ann.bounds.x,
                      y: ann.bounds.y,
                      w: ann.bounds.width,
                      h: ann.bounds.height,
                      bounds: {
                        minX: ann.bounds.x,
                        minY: ann.bounds.y,
                        maxX: ann.bounds.x + ann.bounds.width,
                        maxY: ann.bounds.y + ann.bounds.height,
                      },
                    },
                  },
                },
              };
              console.log('[Iframe Annotator] Adding region annotation:', JSON.stringify(annotoriousAnnotation, null, 2));
              imageAnnotator.addAnnotation(annotoriousAnnotation);
              console.log('[Iframe Annotator] Loaded region annotation:', ann.id);

              // Apply styling after a short delay to let Annotorious render
              if (ann.type) {
                applyRegionAnnotationStyle(ann.id, ann.type);
              }
            } catch (e) {
              console.warn('[Iframe Annotator] Error loading region annotation:', e);
            }
          }
        });
      }
      break;
    }

    case 'CLEAR_REGION_ANNOTATIONS':
      // Suppress delete events during clear (we're just switching questions, not deleting data)
      suppressDeleteEvents = true;
      imageAnnotators.forEach(ann => {
        try {
          ann.clearAnnotations();
        } catch (e) {
          console.warn('[Iframe Annotator] Error clearing region annotations:', e);
        }
      });
      suppressDeleteEvents = false;
      regionAnnotationIndex = 0;
      break;

    case 'REMOVE_REGION_ANNOTATION': {
      const { annotationId, imageId } = message.payload as { annotationId: string; imageId?: string };
      if (annotationId) {
        if (imageId) {
          // Remove from specific image annotator
          const imageAnnotator = imageAnnotators.get(imageId);
          if (imageAnnotator) {
            try {
              imageAnnotator.removeAnnotation(annotationId);
              console.log('[Iframe Annotator] Removed region annotation:', annotationId);
            } catch (e) {
              console.warn('[Iframe Annotator] Error removing region annotation:', e);
            }
          }
        } else {
          // Try to remove from all image annotators
          imageAnnotators.forEach(ann => {
            try {
              ann.removeAnnotation(annotationId);
            } catch (e) {
              // Ignore - annotation might not be on this image
            }
          });
          console.log('[Iframe Annotator] Removed region annotation from all:', annotationId);
        }
      }
      break;
    }
  }
}

// Initialize
console.log('[Iframe Annotator] Script loaded, waiting for messages...');
window.addEventListener('message', handleMessage);

// Forward keyboard shortcuts to parent when iframe has focus
document.addEventListener('keydown', (e) => {
  // Don't intercept if user is typing in an input
  if ((e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA') {
    return;
  }

  // Don't intercept when modifier keys are held (allow Ctrl+R, Cmd+R, etc.)
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }

  // Tool switching shortcuts
  if (e.key === '1' || e.key === 'r') {
    e.preventDefault();
    window.parent.postMessage({ type: 'KEY_PRESSED', payload: { key: 'r' } }, '*');
  } else if (e.key === '2' || e.key === 'a') {
    e.preventDefault();
    window.parent.postMessage({ type: 'KEY_PRESSED', payload: { key: 'a' } }, '*');
  } else if (e.key === 'Escape' || e.key === '0' || e.key === 's') {
    e.preventDefault();
    window.parent.postMessage({ type: 'KEY_PRESSED', payload: { key: 's' } }, '*');
  }
});

// Signal that the iframe is ready to receive content
window.parent.postMessage({ type: 'IFRAME_LOADED' }, '*');
