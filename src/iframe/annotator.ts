/**
 * Annotator script that runs inside the iframe context
 * This allows Recogito and Annotorious to properly detect text and image selections
 * Also integrates webmarker for auto-detecting interactive elements
 */

import { createTextAnnotator } from '@recogito/text-annotator';
import { createImageAnnotator } from '@annotorious/annotorious';
import { mark, unmark, type MarkedElement } from 'webmarker-js';
import { autoUpdate, computePosition } from '@floating-ui/dom';
import '@recogito/text-annotator/text-annotator.css';
import '@annotorious/annotorious/annotorious.css';

// Annotorious CSS class names (hardcoded by the library, not configurable)
// These are used to query DOM elements created by Annotorious
const ANNOTORIOUS_CLASSES = {
  annotationLayer: '.a9s-annotationlayer',
  annotation: '.a9s-annotation',
  inner: '.a9s-inner',
  selected: '.a9s-selected',
  drawing: '.a9s-drawing',
} as const;

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
// Note: Currently not modified, but kept as let for potential future use
// eslint-disable-next-line prefer-const
let suppressDeleteEvents = false;

// Webmarker state
let marksEnabled = false;
let currentMarkedElements: Record<string, MarkedElement> = {};

// Store annotation metadata for re-applying styles after Recogito re-renders
const annotationMeta: Map<string, { tool: string; index: number }> = new Map();

// Store annotation text for scrolling to off-screen annotations
const annotationText: Map<string, string> = new Map();

// Store element annotation data for position updates
interface ElementAnnotationData {
  annotationId: string;
  selector: string;
  annotationType: 'relevant' | 'answer';
  index: number;
  box: HTMLElement;
  badge: HTMLElement;
  cleanup: () => void; // Cleanup function for autoUpdate
}
const elementAnnotationVisuals: Map<string, ElementAnnotationData> = new Map();

// Block-level elements that should have space/newline between them
const BLOCK_ELEMENTS = new Set([
  'DIV',
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TR',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'PRE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'NAV',
  'ASIDE',
  'MAIN',
  'FIGURE',
  'FIGCAPTION',
  'DT',
  'DD',
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
  // This ensures the MutationObserver can pick up elements when they appear
  if (index !== undefined) {
    annotationMeta.set(annotationId, { tool, index });
  }

  // Recogito uses data attributes on highlight spans
  const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);

  // If no elements found, try alternative selector or let MutationObserver handle it
  if (elements.length === 0) {
    const altElements = document.querySelectorAll(
      `.r6o-annotation[data-annotation="${annotationId}"]`
    );
    if (altElements.length === 0) {
      // Elements not yet rendered - MutationObserver will catch them when they appear
      return;
    }
    // Use alternative elements if found
    altElements.forEach((el, i) => {
      const htmlEl = el as HTMLElement;
      applyStylesToElement(htmlEl, el, tool, i === 0 ? index : undefined);
    });
    return;
  }

  // Note: Highlight layer and parent container styles are handled by CSS (annotator.css)

  elements.forEach((el, i) => {
    const htmlEl = el as HTMLElement;
    applyStylesToElement(htmlEl, el, tool, i === 0 ? index : undefined);
  });
}

// Helper function to apply styles to a single element
function applyStylesToElement(
  htmlEl: HTMLElement,
  el: Element,
  tool: string,
  index?: number,
  skipLog = false
) {
  // Check if class is already applied to avoid unnecessary updates
  if (el.classList.contains(`annotation-${tool}`) && !skipLog) {
    return; // Skip if already styled correctly
  }

  // Add class for CSS styling - CSS handles all the styling with !important rules
  el.classList.add(`annotation-${tool}`);
  // Add number badge to first element only
  if (index !== undefined) {
    el.setAttribute('data-annotation-index', String(index));
    el.classList.add('has-index');
  }
}

// Re-apply all annotation styles (called by MutationObserver)
function reapplyAllStyles(skipLog = false) {
  // Note: Container and highlight layer styles are handled by CSS (annotator.css)
  // which is loaded as an inline style tag with !important rules

  annotationMeta.forEach((meta, annotationId) => {
    const elements = document.querySelectorAll(`[data-annotation="${annotationId}"]`);
    if (elements.length > 0) {
      elements.forEach((el, i) => {
        const htmlEl = el as HTMLElement;
        applyStylesToElement(htmlEl, el, meta.tool, i === 0 ? meta.index : undefined, skipLog);
      });
    }
  });
}

// Colors for region annotations
const REGION_COLORS = {
  relevant: { fill: 'rgba(6, 182, 212, 0.25)', stroke: 'rgb(6, 182, 212)' },
  answer: { fill: 'rgba(236, 72, 153, 0.25)', stroke: 'rgb(236, 72, 153)' },
};

// Apply style to a specific annotation (used when loading saved annotations)
function applyRegionAnnotationStyle(annotationId: string, tool: string) {
  const colors = REGION_COLORS[tool as keyof typeof REGION_COLORS] || REGION_COLORS.relevant;

  // Find and style the annotation element
  setTimeout(() => {
    const annotationLayers = document.querySelectorAll(ANNOTORIOUS_CLASSES.annotationLayer);
    annotationLayers.forEach((layer) => {
      const groups = layer.querySelectorAll(`g${ANNOTORIOUS_CLASSES.annotation}`);
      groups.forEach((g) => {
        const dataId = g.getAttribute('data-id') || g.id || '';
        if (dataId === annotationId || dataId.includes(annotationId)) {
          g.classList.add(`annotation-${tool}`);
          const inner = g.querySelector(ANNOTORIOUS_CLASSES.inner);
          if (inner) {
            (inner as SVGElement).style.fill = colors.fill;
            (inner as SVGElement).style.stroke = colors.stroke;
            (inner as SVGElement).style.strokeWidth = '2px';
          }
        }
      });
    });
  }, 50);
}

// MutationObserver to re-apply styles when Recogito re-renders
let styleObserver: MutationObserver | null = null;

// Initialize annotator on the content
async function initializeAnnotator(container: HTMLElement) {
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

  // Add custom styles for annotation colors - await to ensure it's loaded
  // This ensures CSS is available before any annotations are created
  await injectAnnotationStyles().catch((err) => {
    console.error('[Iframe Annotator] Error injecting styles:', err);
  });

  // Don't use style function - it would apply currentTool color to ALL annotations
  // Instead we apply colors per-annotation via applyAnnotationStyle
  annotator = createTextAnnotator(container, {
    annotatingEnabled: currentTool !== 'select',
  });

  // Set up MutationObserver to re-apply styles when Recogito modifies DOM
  let reapplyTimeout: number | null = null;
  styleObserver = new MutationObserver((mutations) => {
    // Only react to mutations that aren't from our own style changes
    const hasNonStyleMutation = mutations.some((m) => {
      if (m.type === 'attributes' && m.attributeName === 'style') {
        // Check if this is from Recogito, not from us
        const target = m.target as HTMLElement;
        return (
          !target.hasAttribute('data-annotation') ||
          (!target.classList.contains('annotation-relevant') &&
            !target.classList.contains('annotation-answer'))
        );
      }
      return m.type !== 'attributes' || m.attributeName !== 'style';
    });

    if (hasNonStyleMutation) {
      // Debounce re-application with longer delay to avoid loops
      if (reapplyTimeout) {
        clearTimeout(reapplyTimeout);
      }
      reapplyTimeout = window.setTimeout(() => {
        reapplyAllStyles(true); // Pass skipLog=true to reduce noise
        reapplyTimeout = null;
      }, 100);
    }
  });

  styleObserver.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
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

    window.parent.postMessage(
      {
        type: 'ANNOTATION_CREATED',
        payload: { annotation: serialized, tool: currentTool, index: annotationIndex },
      },
      '*'
    );
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

    window.parent.postMessage(
      {
        type: 'ANNOTATION_DELETED',
        payload: { annotation: serialized },
      },
      '*'
    );
  });

  // Handle annotation click/selection
  annotator.on('clickAnnotation', (annotation: unknown) => {
    console.log('[Iframe Annotator] Annotation clicked:', annotation);
    const ann = annotation as { id?: string };
    if (ann.id) {
      highlightAnnotation(ann.id);
      window.parent.postMessage(
        {
          type: 'ANNOTATION_CLICKED',
          payload: { annotationId: ann.id },
        },
        '*'
      );
    }
  });
}

// Initialize image annotators for all images in the container
function initializeImageAnnotators(container: HTMLElement) {
  console.log('[Iframe Annotator] Initializing image annotators');

  // Destroy existing image annotators
  imageAnnotators.forEach((ann) => {
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
        // Style function reads type from annotation bodies, not current tool
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        style: (annotation: any) => {
          const ann = annotation as { bodies?: Array<{ purpose?: string; value?: string }> };
          // Find the tagging body that stores our type
          const typeBody = ann.bodies?.find((b) => b.purpose === 'tagging');
          const type = typeBody?.value || 'relevant';
          const colors =
            REGION_COLORS[type as keyof typeof REGION_COLORS] || REGION_COLORS.relevant;
          return {
            fill: colors.fill as any,
            stroke: colors.stroke as any,
            strokeWidth: 2,
          };
        },
      });

      // Check if Annotorious wrapped the image and if dimensions collapsed
      const wrapper = img.parentElement;
      if (wrapper && wrapper !== originalParent) {
        const wrapperRect = wrapper.getBoundingClientRect();

        // Only apply explicit dimensions if the wrapper collapsed (much smaller than original)
        const collapsed =
          wrapperRect.width < originalWidth * 0.5 || wrapperRect.height < originalHeight * 0.5;

        if (collapsed && originalWidth > 0 && originalHeight > 0) {
          console.log(
            '[Iframe Annotator] Fixing collapsed wrapper for:',
            imgId,
            'original:',
            originalWidth,
            'x',
            originalHeight
          );
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

        console.log(
          '[Iframe Annotator] Region annotation created (raw):',
          JSON.stringify(annotation, null, 2)
        );

        const ann = annotation as {
          id?: string;
          target?: unknown;
          bodies?: Array<{ purpose?: string; value?: string }>;
        };
        regionAnnotationIndex++;

        // Add type body to the annotation so the style function can read it
        if (ann.id) {
          const typeBody = { purpose: 'tagging', value: currentTool };
          const updatedAnn = {
            ...ann,
            bodies: [...(ann.bodies || []), typeBody],
          };
          // Update the annotation with the type body
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          imageAnnotator.updateAnnotation(updatedAnn as any);

          // Apply additional styling
          applyRegionAnnotationStyle(ann.id, currentTool);
        }

        const serialized = serializeAnnotation(annotation);
        console.log(
          '[Iframe Annotator] Region annotation serialized:',
          JSON.stringify(serialized, null, 2)
        );

        window.parent.postMessage(
          {
            type: 'REGION_ANNOTATION_CREATED',
            payload: {
              annotation: serialized,
              tool: currentTool,
              imageId: imgId,
              index: regionAnnotationIndex,
            },
          },
          '*'
        );
      });

      // Handle region annotation deletion
      imageAnnotator.on('deleteAnnotation', (annotation: unknown) => {
        // Don't send delete events during clear operations (e.g., switching questions)
        if (suppressDeleteEvents) {
          console.log(
            '[Iframe Annotator] Region annotation delete suppressed (clearing):',
            annotation
          );
          return;
        }

        console.log('[Iframe Annotator] Region annotation deleted:', annotation);

        const serialized = serializeAnnotation(annotation);

        window.parent.postMessage(
          {
            type: 'REGION_ANNOTATION_DELETED',
            payload: { annotation: serialized, imageId: imgId },
          },
          '*'
        );
      });

      // Handle region annotation click
      imageAnnotator.on('clickAnnotation', (annotation: unknown) => {
        console.log('[Iframe Annotator] Region annotation clicked:', annotation);
        const ann = annotation as { id?: string };
        if (ann.id) {
          window.parent.postMessage(
            {
              type: 'ANNOTATION_CLICKED',
              payload: { annotationId: ann.id },
            },
            '*'
          );
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
  imageAnnotators.forEach((ann) => {
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
  document.querySelectorAll('.selected, .pl-selected').forEach((el) => {
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
      elements.forEach((el) => {
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
            behavior: 'smooth',
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
  console.log(
    '[Iframe Annotator] Text stored for annotation:',
    annotationId,
    '=',
    searchText?.substring(0, 50)
  );

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
        behavior: 'smooth',
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
    normalizedSearch, // Full normalized text
    normalizedSearch.substring(0, 50), // First 50 chars
    normalizedSearch.substring(0, 30), // First 30 chars
    normalizedSearch.split(' ').slice(0, 5).join(' '), // First 5 words
  ];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);

  // Build a map of text content for searching
  const textNodes: Array<{ node: Node; text: string; normalizedText: string }> = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    if (text.trim()) {
      textNodes.push({
        node,
        text,
        normalizedText: text.replace(/\s+/g, ' '),
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
        console.log(
          '[Iframe Annotator] Found case-insensitive match for:',
          searchStr.substring(0, 30)
        );
        return { node, offset: index };
      }
    }
  }

  console.log('[Iframe Annotator] No text match found for any strategy');
  return null;
}

// Inject custom styles for annotation colors
async function injectAnnotationStyles() {
  if (document.getElementById('pl-annotation-styles')) {
    console.log('[Iframe Annotator] Styles already injected');
    return;
  }

  // Get URL for extension resource (available in extension-owned iframes)
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
    console.error('[Iframe Annotator] chrome.runtime.getURL not available');
    return;
  }

  const cssUrl = chrome.runtime.getURL('annotator.css');
  console.log('[Iframe Annotator] Injecting styles from:', cssUrl);

  // Try to fetch and inject CSS as inline style to avoid CSP blocking
  // Some sites block external stylesheets even from extension resources
  try {
    const response = await fetch(cssUrl);
    if (response.ok) {
      const cssText = await response.text();
      console.log('[Iframe Annotator] CSS fetched, length:', cssText.length);
      const style = document.createElement('style');
      style.id = 'pl-annotation-styles';
      style.textContent = cssText;
      document.head.appendChild(style);
      console.log('[Iframe Annotator] CSS injected as inline style');
      return;
    } else {
      console.warn('[Iframe Annotator] CSS fetch failed with status:', response.status);
    }
  } catch (error) {
    console.warn('[Iframe Annotator] CSS fetch error:', error);
    // Fallback to link tag if fetch fails
  }

  // Fallback to link tag if fetch fails (shouldn't happen in extension context)
  const link = document.createElement('link');
  link.id = 'pl-annotation-styles';
  link.rel = 'stylesheet';
  link.href = cssUrl;
  document.head.appendChild(link);
}

// Generate a unique CSS selector for an element
function getUniqueSelector(element: Element): string {
  // Try ID first
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  // Build path from element to a unique ancestor
  const path: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    // Add class if available
    if (current.className && typeof current.className === 'string') {
      const classes = current.className
        .trim()
        .split(/\s+/)
        .filter((c) => c && !c.startsWith('webmarker'));
      if (classes.length > 0) {
        selector +=
          '.' +
          classes
            .slice(0, 2)
            .map((c) => CSS.escape(c))
            .join('.');
      }
    }

    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;

    // Stop if we have enough specificity
    if (path.length >= 4) break;
  }

  return path.join(' > ');
}

// Get text preview from element
function getTextPreview(element: Element): string {
  const text = element.textContent?.trim() || '';
  // Also check for aria-label, title, placeholder, value
  const ariaLabel = element.getAttribute('aria-label') || '';
  const title = element.getAttribute('title') || '';
  const placeholder = element.getAttribute('placeholder') || '';
  const value = (element as HTMLInputElement).value || '';

  const preview =
    text || ariaLabel || title || placeholder || value || element.tagName.toLowerCase();
  return preview.substring(0, 50) + (preview.length > 50 ? '...' : '');
}

// Check if element A contains/wraps element B (B is inside A)
function elementContains(a: Element, b: Element): boolean {
  return a !== b && a.contains(b);
}

// Calculate overlap ratio (how much of the smaller element is covered by the larger)
function getOverlapRatio(rectA: DOMRect, rectB: DOMRect): number {
  const xOverlap = Math.max(
    0,
    Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left)
  );
  const yOverlap = Math.max(
    0,
    Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top)
  );
  const overlapArea = xOverlap * yOverlap;

  const areaA = rectA.width * rectA.height;
  const areaB = rectB.width * rectB.height;
  const smallerArea = Math.min(areaA, areaB);

  if (smallerArea === 0) return 0;
  return overlapArea / smallerArea;
}

// Check if element is part of annotator overlays (should be excluded)
function isAnnotatorElement(element: Element): boolean {
  // Check if element or any ancestor is an annotator overlay
  let current: Element | null = element;
  while (current) {
    if (
      current.classList.contains('a9s-annotationlayer') ||
      current.classList.contains('a9s-annotation') ||
      current.classList.contains('r6o-annotation') ||
      current.classList.contains('webmarker') ||
      current.classList.contains('webmarker-bounding-box') ||
      current.classList.contains('element-annotation') ||
      current.classList.contains('element-annotation-badge')
    ) {
      return true;
    }
    // Check for SVG annotation layers
    if (current.tagName === 'svg' && current.closest(ANNOTORIOUS_CLASSES.annotationLayer)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

// Deduplicate overlapping elements - keep the largest one
function dedupeMarkedElements(
  markedElements: Record<string, MarkedElement>
): Record<string, MarkedElement> {
  const entries = Object.entries(markedElements);
  const toRemove = new Set<string>();

  // First pass: remove annotator elements
  for (const [label, marked] of entries) {
    if (isAnnotatorElement(marked.element)) {
      toRemove.add(label);
      console.log(
        '[Iframe Annotator] Filtering out annotator element:',
        label,
        marked.element.tagName
      );
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const [labelA, markedA] = entries[i];
    if (toRemove.has(labelA)) continue;

    const rectA = markedA.element.getBoundingClientRect();
    const areaA = rectA.width * rectA.height;

    for (let j = i + 1; j < entries.length; j++) {
      const [labelB, markedB] = entries[j];
      if (toRemove.has(labelB)) continue;

      const rectB = markedB.element.getBoundingClientRect();
      const areaB = rectB.width * rectB.height;

      // Check if one contains the other in DOM
      const aContainsB = elementContains(markedA.element, markedB.element);
      const bContainsA = elementContains(markedB.element, markedA.element);

      // Check overlap ratio
      const overlapRatio = getOverlapRatio(rectA, rectB);

      // If significant overlap (>70%) or one contains the other, keep the larger one
      if (overlapRatio > 0.7 || aContainsB || bContainsA) {
        if (areaA >= areaB) {
          toRemove.add(labelB);
          console.log(
            '[Iframe Annotator] Deduping:',
            labelB,
            'covered by',
            labelA,
            `(overlap: ${(overlapRatio * 100).toFixed(0)}%, contains: ${aContainsB})`
          );
        } else {
          toRemove.add(labelA);
          console.log(
            '[Iframe Annotator] Deduping:',
            labelA,
            'covered by',
            labelB,
            `(overlap: ${(overlapRatio * 100).toFixed(0)}%, contains: ${bContainsA})`
          );
          break; // A is removed, no need to compare it further
        }
      }
    }
  }

  // Remove the duplicates from webmarker visuals and return filtered result
  const result: Record<string, MarkedElement> = {};
  for (const [label, marked] of entries) {
    if (toRemove.has(label)) {
      // Remove the visual elements
      marked.markElement.remove();
      marked.boundingBoxElement?.remove();
      marked.element.removeAttribute('data-mark-label');
    } else {
      result[label] = marked;
    }
  }

  console.log(
    '[Iframe Annotator] Deduped from',
    entries.length,
    'to',
    Object.keys(result).length,
    'elements'
  );
  return result;
}

// Get selectors of already annotated elements
function getAnnotatedSelectors(): Set<string> {
  const selectors = new Set<string>();
  elementAnnotationVisuals.forEach((data) => {
    selectors.add(data.selector);
  });
  return selectors;
}

// Enable webmarker detection
function enableMarks(container: HTMLElement) {
  if (marksEnabled) {
    unmark();
  }

  console.log('[Iframe Annotator] Enabling webmarker detection');

  // Custom selector that includes images and links (with href or data-original-href from MHTML capture)
  const selector =
    'a[href], a[data-original-href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"]), img';

  // Get already annotated element selectors to filter them out
  const annotatedSelectors = getAnnotatedSelectors();

  // Custom styling for marks
  const rawMarkedElements = mark({
    containerElement: container,
    selector,
    showBoundingBoxes: true,
    markStyle: {
      backgroundColor: '#6366f1',
      color: 'white',
      padding: '2px 6px',
      fontSize: '11px',
      fontWeight: 'bold',
      borderRadius: '4px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
      cursor: 'pointer',
      pointerEvents: 'auto',
    },
    boundingBoxStyle: {
      outline: '2px solid #6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
    },
    markPlacement: 'top-start',
  });

  // Filter out already annotated elements
  const filteredMarkedElements: Record<string, MarkedElement> = {};
  for (const [label, marked] of Object.entries(rawMarkedElements)) {
    const markedEl = marked as MarkedElement;
    const elementSelector = getUniqueSelector(markedEl.element);
    if (annotatedSelectors.has(elementSelector)) {
      // Remove the mark visual since this element is already annotated
      markedEl.markElement.remove();
      markedEl.boundingBoxElement?.remove();
      console.log('[Iframe Annotator] Skipping already annotated element:', elementSelector);
    } else {
      filteredMarkedElements[label] = markedEl;
    }
  }

  // Deduplicate overlapping elements
  currentMarkedElements = dedupeMarkedElements(filteredMarkedElements);

  marksEnabled = true;

  // Convert marked elements to data format and send to parent
  const marksData = Object.entries(currentMarkedElements).map(([label, markedEl]) => {
    const rect = markedEl.element.getBoundingClientRect();
    return {
      label,
      tagName: markedEl.element.tagName.toLowerCase(),
      textPreview: getTextPreview(markedEl.element),
      selector: getUniqueSelector(markedEl.element),
      bounds: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
    };
  });

  console.log('[Iframe Annotator] Detected', marksData.length, 'interactive elements');

  // Add click handlers to marks for naming
  // Note: pointer-events and cursor are handled by CSS (.webmarker, .webmarker-bounding-box)
  Object.entries(currentMarkedElements).forEach(([label, markedEl]) => {
    markedEl.markElement.addEventListener('click', (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[Iframe Annotator] Mark clicked:', label);

      // Notify parent that a mark was clicked
      window.parent.postMessage(
        {
          type: 'MARK_CLICKED',
          payload: { label },
        },
        '*'
      );
    });

    // Also add click handler to bounding box
    if (markedEl.boundingBoxElement) {
      markedEl.boundingBoxElement.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[Iframe Annotator] Mark bounding box clicked:', label);

        window.parent.postMessage(
          {
            type: 'MARK_CLICKED',
            payload: { label },
          },
          '*'
        );
      });
    }
  });

  window.parent.postMessage(
    {
      type: 'MARKS_DETECTED',
      payload: { marks: marksData },
    },
    '*'
  );
}

// Disable webmarker detection
function disableMarks() {
  if (!marksEnabled) return;

  console.log('[Iframe Annotator] Disabling webmarker detection');
  unmark();
  marksEnabled = false;
  currentMarkedElements = {};

  window.parent.postMessage(
    {
      type: 'MARKS_CLEARED',
      payload: {},
    },
    '*'
  );
}

// Highlight a specific mark
function highlightMark(label: string) {
  const markedEl = currentMarkedElements[label];
  if (!markedEl) return;

  // Remove previous highlights
  document
    .querySelectorAll('.webmarker-highlighted, .webmarker-bounding-box-highlighted')
    .forEach((el) => {
      el.classList.remove('webmarker-highlighted', 'webmarker-bounding-box-highlighted');
    });

  // Add highlight to this mark
  markedEl.markElement.classList.add('webmarker-highlighted');
  if (markedEl.boundingBoxElement) {
    markedEl.boundingBoxElement.classList.add('webmarker-bounding-box-highlighted');
  }

  // Scroll to the element
  markedEl.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Update mark label with user-assigned name
function updateMarkLabel(label: string, name: string) {
  const markedEl = currentMarkedElements[label];
  if (!markedEl) return;

  // Update the mark element text
  markedEl.markElement.textContent = name || label;

  // Add 'named' class for styling
  if (name) {
    markedEl.markElement.classList.add('webmarker-named');
  } else {
    markedEl.markElement.classList.remove('webmarker-named');
  }
}

// Remove a specific mark
function removeMark(label: string) {
  const markedEl = currentMarkedElements[label];
  if (!markedEl) return;

  // Remove mark element
  markedEl.markElement.remove();

  // Remove bounding box if exists
  if (markedEl.boundingBoxElement) {
    markedEl.boundingBoxElement.remove();
  }

  // Remove the data attribute from the element
  markedEl.element.removeAttribute('data-mark-label');

  // Remove from tracking
  delete currentMarkedElements[label];

  console.log('[Iframe Annotator] Removed mark:', label);
}

// Unified annotation index for all annotation types (text, region, element)
// This gets synced from the viewer to ensure consistent numbering

// Convert a mark to an annotation visual
// Removes webmarker elements and creates fresh ones using the unified createElementAnnotationVisual
function convertMarkToAnnotation(
  label: string,
  annotationId: string,
  annotationType: 'relevant' | 'answer',
  index?: number
) {
  const markedEl = currentMarkedElements[label];
  if (!markedEl) return;

  // Get the annotation index (passed from parent)
  const annotationNumber = index ?? annotationIndex;
  const element = markedEl.element;
  const selector = getUniqueSelector(element);

  // Remove the webmarker elements completely
  markedEl.markElement.remove();
  if (markedEl.boundingBoxElement) {
    markedEl.boundingBoxElement.remove();
  }
  element.removeAttribute('data-mark-label');

  // Remove from webmarker tracking
  delete currentMarkedElements[label];

  // Create fresh annotation visual using the unified function
  createElementAnnotationVisual(annotationId, selector, annotationType, annotationNumber);

  console.log(
    '[Iframe Annotator] Converted mark to annotation:',
    label,
    '->',
    annotationId,
    'index:',
    annotationNumber
  );
}

// Create element annotation visual from a CSS selector (for reloading saved annotations)
function createElementAnnotationVisual(
  annotationId: string,
  selector: string,
  annotationType: 'relevant' | 'answer',
  index: number
) {
  // Try to find the element
  let element: Element | null = null;
  try {
    element = document.querySelector(selector);
  } catch (e) {
    console.warn('[Iframe Annotator] Invalid selector:', selector);
  }

  if (!element) {
    console.warn('[Iframe Annotator] Element not found for selector:', selector);
    return;
  }

  // Create the bounding box
  const box = document.createElement('div');
  box.className = `element-annotation element-annotation-${annotationType}`;
  box.setAttribute('data-annotation-id', annotationId);
  // Only set positioning-related inline styles - let CSS handle colors/outline
  // This ensures CSS !important rules can apply properly
  box.style.position = 'absolute';
  box.style.display = 'block';
  box.style.pointerEvents = 'auto';
  box.style.cursor = 'pointer';
  box.style.zIndex = '2147483646'; // Match text annotation z-index
  box.style.visibility = 'visible';
  box.style.opacity = '1';
  box.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage(
      {
        type: 'ANNOTATION_CLICKED',
        payload: { annotationId },
      },
      '*'
    );
  };
  document.body.appendChild(box);

  // Create the badge
  const badge = document.createElement('div');
  badge.className = `element-annotation-badge element-annotation-badge-${annotationType}`;
  badge.setAttribute('data-annotation-id', annotationId);
  badge.textContent = String(index);
  // Only set positioning-related inline styles - let CSS handle colors/styling
  // This ensures CSS !important rules can apply properly
  badge.style.position = 'absolute';
  badge.style.display = 'block';
  badge.style.zIndex = '2147483647'; // Maximum z-index to be above everything
  badge.style.visibility = 'visible';
  badge.style.opacity = '1';
  badge.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.parent.postMessage(
      {
        type: 'ANNOTATION_CLICKED',
        payload: { annotationId },
      },
      '*'
    );
  };
  document.body.appendChild(badge);

  // Use autoUpdate for smooth position tracking - match webmarker's exact positioning approach
  const cleanupFns: (() => void)[] = [];

  // Position the bounding box to cover the element (same as webmarker)
  // Use Floating UI's autoUpdate for smooth, efficient positioning
  function updateBoxPosition() {
    computePosition(element!, box, { placement: 'top-start' }).then(({ x, y }) => {
      const { width, height } = element!.getBoundingClientRect();
      box.style.left = `${x}px`;
      box.style.top = `${y + height}px`; // webmarker adds height to cover element
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
    });
  }
  cleanupFns.push(autoUpdate(element, box, updateBoxPosition));

  // Position the badge at top-start of the element (same as webmarker mark placement)
  function updateBadgePosition() {
    computePosition(element!, badge, { placement: 'top-start' }).then(({ x, y }) => {
      badge.style.left = `${x}px`;
      badge.style.top = `${y}px`; // raw position from top-start, same as webmarker
    });
  }
  cleanupFns.push(autoUpdate(element, badge, updateBadgePosition));

  // Store for cleanup
  elementAnnotationVisuals.set(annotationId, {
    annotationId,
    selector,
    annotationType,
    index,
    box,
    badge,
    cleanup: () => cleanupFns.forEach((fn) => fn()),
  });

  console.log(
    '[Iframe Annotator] Created element annotation visual:',
    annotationId,
    'at',
    selector
  );
}

// Remove element annotation visual
function removeElementAnnotationVisual(annotationId: string) {
  const data = elementAnnotationVisuals.get(annotationId);
  if (data) {
    data.cleanup(); // Stop autoUpdate
    data.box.remove();
    data.badge.remove();
    elementAnnotationVisuals.delete(annotationId);
  }
}

// Handle messages from parent
async function handleMessage(event: MessageEvent) {
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

        // Force layout recalculation to ensure body/html expands to fit content
        // This fixes the issue where the page appears white at the bottom until scrolled
        const forceLayoutRecalculation = () => {
          // Force a reflow by reading layout properties
          void container.offsetHeight;
          void document.body.offsetHeight;
          void document.documentElement.offsetHeight;
          // Trigger a scroll event to force layout recalculation
          window.scrollTo(0, 0);
        };

        // Wait for images to load, then force layout recalculation
        const images = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
        if (images.length > 0) {
          // Create promises for all image loads
          const imageLoadPromises = images.map((img) => {
            if (img.complete) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            });
          });

          // Wait for all images, then recalculate layout
          Promise.all(imageLoadPromises).then(() => {
            requestAnimationFrame(() => {
              forceLayoutRecalculation();
            });
          });
        } else {
          // No images, just force layout recalculation on next frame
          requestAnimationFrame(() => {
            forceLayoutRecalculation();
          });
        }

        // Initialize annotator on the loaded content (await to ensure CSS is loaded)
        await initializeAnnotator(container);

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
          annotations.forEach((ann) => {
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
                const typeBody = ann.bodies?.find(
                  (b) => b.value === 'relevant' || b.value === 'answer'
                );
                const tool = typeBody?.value || 'relevant';
                console.log(
                  '[Iframe Annotator] Applying style to',
                  ann.id,
                  'tool:',
                  tool,
                  'index:',
                  idx + 1
                );
                applyAnnotationStyle(ann.id, tool, idx + 1);
              }
            });
          }, 100);
        }
      }
      break;

    case 'CLEAR_ANNOTATIONS':
      if (annotator) {
        // Use setAnnotations([]) instead of clearAnnotations() to avoid triggering delete events
        // clearAnnotations() fires deleteAnnotation events which we don't want when just switching questions
        try {
          annotator.setAnnotations([]);
        } catch (e) {
          console.warn('[Iframe Annotator] Error setting empty annotations:', e);
        }
        // Also clear metadata, text, and reset index
        annotationMeta.clear();
        annotationText.clear();
        annotationIndex = 0;
      }
      // Also clear element annotation visuals
      elementAnnotationVisuals.forEach((data) => {
        data.cleanup(); // Stop autoUpdate
        data.box.remove();
        data.badge.remove();
      });
      elementAnnotationVisuals.clear();
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
        elements.forEach((el) => {
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
          console.log(
            '[Iframe Annotator] Manually removed',
            elements.length,
            'DOM elements for:',
            annotationId
          );
        }

        // Remove element annotation visuals (bounding box and badge)
        removeElementAnnotationVisual(annotationId);

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
      console.log(
        '[Iframe Annotator] Available image annotators:',
        Array.from(imageAnnotators.keys())
      );

      if (regionAnnotations?.length) {
        regionAnnotationIndex = regionAnnotations.length;

        regionAnnotations.forEach((ann) => {
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
                bodies: [
                  {
                    type: 'TextualBody',
                    purpose: 'tagging',
                    value: ann.type || 'relevant',
                  },
                ],
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
              console.log(
                '[Iframe Annotator] Adding region annotation:',
                JSON.stringify(annotoriousAnnotation, null, 2)
              );
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
      // Use setAnnotations([]) instead of clearAnnotations() to avoid triggering delete events
      imageAnnotators.forEach((ann) => {
        try {
          ann.setAnnotations([]);
        } catch (e) {
          console.warn('[Iframe Annotator] Error setting empty region annotations:', e);
        }
      });
      regionAnnotationIndex = 0;
      break;

    case 'REMOVE_REGION_ANNOTATION': {
      const { annotationId, imageId } = message.payload as {
        annotationId: string;
        imageId?: string;
      };
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
          imageAnnotators.forEach((ann) => {
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

    // Webmarker messages
    case 'ENABLE_MARKS': {
      const container = document.getElementById('content-container');
      if (container) {
        enableMarks(container);
      }
      break;
    }

    case 'DISABLE_MARKS':
      disableMarks();
      break;

    case 'HIGHLIGHT_MARK': {
      const { label } = message.payload as { label: string };
      if (label) {
        highlightMark(label);
      }
      break;
    }

    case 'UPDATE_MARK_LABEL': {
      const { label, name } = message.payload as { label: string; name: string };
      if (label) {
        updateMarkLabel(label, name);
      }
      break;
    }

    case 'REMOVE_MARK': {
      const { label } = message.payload as { label: string };
      if (label) {
        removeMark(label);
      }
      break;
    }

    case 'CONVERT_MARK_TO_ANNOTATION': {
      const { label, annotationId, annotationType, index } = message.payload as {
        label: string;
        annotationId: string;
        annotationType: 'relevant' | 'answer';
        index?: number;
      };
      if (label && annotationId) {
        convertMarkToAnnotation(label, annotationId, annotationType, index);
      }
      break;
    }

    case 'GET_MARKS_STATUS':
      window.parent.postMessage(
        {
          type: 'MARKS_STATUS',
          payload: { enabled: marksEnabled, count: Object.keys(currentMarkedElements).length },
        },
        '*'
      );
      break;

    case 'SET_ANNOTATION_INDEX': {
      const { index } = message.payload as { index: number };
      annotationIndex = index;
      console.log('[Iframe Annotator] Annotation index set to:', index);
      break;
    }

    case 'LOAD_ELEMENT_ANNOTATIONS': {
      const elementAnnotations = message.payload as Array<{
        id: string;
        selector: string;
        type: 'relevant' | 'answer';
        index: number;
      }>;
      console.log('[Iframe Annotator] Loading element annotations:', elementAnnotations);

      for (const ann of elementAnnotations) {
        createElementAnnotationVisual(ann.id, ann.selector, ann.type, ann.index);
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
  if (
    (e.target as HTMLElement).tagName === 'INPUT' ||
    (e.target as HTMLElement).tagName === 'TEXTAREA'
  ) {
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
