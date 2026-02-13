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
  ElementMark,
  Trace,
  InteractionRecord,
} from '@/types';

// Import annotation library types (actual annotators are now in iframe)
import '@recogito/text-annotator/text-annotator.css';
import '@annotorious/annotorious/annotorious.css';

// Strip CSP meta tags from HTML to allow our annotation scripts to run
function stripCspFromHtml(html: string): string {
  // Remove Content-Security-Policy meta tags
  return html
    .replace(/<meta[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '')
    .replace(
      /<meta[^>]*content=["'][^"']*script-src[^"']*["'][^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi,
      ''
    );
}

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
let focusMode = false;

// Trace viewing state
let currentTrace: Trace | null = null;
let currentInteractionIndex: number = -1;
let traceMode = false;
let showingPreAction = true; // Toggle between pre and post action snapshots
let viewingInitialSnapshot = false; // True when viewing initial snapshot
let viewingFinalSnapshot = false; // True when viewing final snapshot

// Webmarker state
let marksEnabled = false;
let detectedMarks: Array<{
  label: string;
  tagName: string;
  textPreview: string;
  selector: string;
  bounds: { x: number; y: number; width: number; height: number };
}> = [];

// Note: Annotation library instances are now managed in the iframe

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

async function getTraceFromStorage(id: string): Promise<Trace | null> {
  const key = `trace_${id}`;
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

// Load trace and enter trace viewing mode
async function loadTrace(traceId: string) {
  try {
    const trace = await getTraceFromStorage(traceId);
    if (!trace) {
      console.error('Trace not found:', traceId);
      return;
    }

    currentTrace = trace;
    traceMode = true;
    currentInteractionIndex = -1;
    viewingInitialSnapshot = false;
    viewingFinalSnapshot = false;

    // Show trace UI
    showTraceUI();

    // Load initial snapshot if available, otherwise load first interaction
    if (trace.initialSnapshotId) {
      await loadInitialSnapshot();
    } else if (trace.interactions.length > 0) {
      await loadInteraction(0, true);
    }
  } catch (error) {
    console.error('Failed to load trace:', error);
  }
}

// Load initial snapshot
async function loadInitialSnapshot() {
  if (!currentTrace || !currentTrace.initialSnapshotId) {
    return;
  }

  viewingInitialSnapshot = true;
  viewingFinalSnapshot = false;
  currentInteractionIndex = -1;

  await loadSnapshot(currentTrace.initialSnapshotId);
  updateTimelineUI();
}

// Load final snapshot
async function loadFinalSnapshot() {
  if (!currentTrace || !currentTrace.finalSnapshotId) {
    return;
  }

  viewingInitialSnapshot = false;
  viewingFinalSnapshot = true;
  currentInteractionIndex = -1;

  await loadSnapshot(currentTrace.finalSnapshotId);
  updateTimelineUI();
}

// Load a specific interaction from the trace
async function loadInteraction(index: number, usePreAction: boolean = true) {
  if (!currentTrace || index < 0 || index >= currentTrace.interactions.length) {
    return;
  }

  viewingInitialSnapshot = false;
  viewingFinalSnapshot = false;
  currentInteractionIndex = index;
  showingPreAction = usePreAction;
  const interaction = currentTrace.interactions[index];

  // Load the appropriate snapshot (pre or post action)
  const snapshotId = usePreAction ? interaction.preSnapshotId : interaction.postSnapshotId;

  // Use the normal loadSnapshot function to ensure proper initialization
  // This ensures all UI is properly set up (questions, annotations, etc.)
  // and annotation tools work correctly
  await loadSnapshot(snapshotId);

  // Highlight the interaction target element after a short delay
  // to ensure iframe is loaded and ready
  setTimeout(() => {
    highlightInteractionTarget(interaction);
  }, 500);

  // Update timeline UI
  updateTimelineUI();
}

// Toggle between pre and post action snapshots
function toggleSnapshotView() {
  if (
    !currentTrace ||
    currentInteractionIndex < 0 ||
    viewingInitialSnapshot ||
    viewingFinalSnapshot
  )
    return;
  showingPreAction = !showingPreAction;
  loadInteraction(currentInteractionIndex, showingPreAction);
}

// Highlight the interaction target element in the iframe
function highlightInteractionTarget(interaction: InteractionRecord) {
  // Don't highlight for initial/final snapshots
  if (viewingInitialSnapshot || viewingFinalSnapshot) return;

  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (!iframe) return;

  sendToIframe(iframe, 'HIGHLIGHT_INTERACTION', {
    selector: interaction.action.target.selector,
    xpath: interaction.action.target.xpath,
    boundingBox: interaction.action.target.boundingBox,
    actionType: interaction.action.type,
    coordinates: interaction.action.coordinates, // Pass click coordinates for animation
  });
}

// Show trace UI elements
function showTraceUI() {
  // Show timeline panel
  const timelinePanel = document.getElementById('trace-timeline-panel');
  if (timelinePanel) {
    timelinePanel.classList.remove('hidden');
  }

  // Hide normal snapshot navigation container (but keep it in DOM for switching back)
  const snapshotNavContainer = document.querySelector('.snapshot-nav-container');
  if (snapshotNavContainer) {
    (snapshotNavContainer as HTMLElement).style.display = 'none';
  }

  // Ensure annotation tools are visible and functional
  // (They should already be set up, but make sure they're enabled)
  const toolBtns = document.querySelectorAll('.tool-btn[data-tool]');
  toolBtns.forEach((btn) => {
    (btn as HTMLElement).style.display = '';
  });

  // Update header
  const pageTitle = document.getElementById('page-title');
  if (pageTitle && currentTrace) {
    pageTitle.textContent = `Trace: ${currentTrace.id.substring(0, 8)}...`;
  }
}

// Update timeline UI
async function updateTimelineUI() {
  if (!currentTrace) return;

  const timelineEl = document.getElementById('trace-timeline');
  if (!timelineEl) return;

  const items: string[] = [];

  // Load initial snapshot data if needed
  let initialSnapshot: Snapshot | null = null;
  if (currentTrace.initialSnapshotId) {
    initialSnapshot = await getSnapshotFromStorage(currentTrace.initialSnapshotId);
  }

  // Add initial snapshot item
  if (currentTrace.initialSnapshotId) {
    const isActive = viewingInitialSnapshot;
    const time = initialSnapshot ? new Date(initialSnapshot.capturedAt).toLocaleTimeString() : '';
    const title = initialSnapshot ? initialSnapshot.title : 'Initial Page';

    items.push(`
      <div class="timeline-item ${isActive ? 'active' : ''}" data-type="initial">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="timeline-action">Initial</div>
          <div class="timeline-time">${time}</div>
          <div class="timeline-target">${escapeHtml(title.substring(0, 30))}${title.length > 30 ? '...' : ''}</div>
        </div>
      </div>
    `);
  }

  // Add interaction items
  items.push(
    ...currentTrace.interactions.map((interaction, idx) => {
      const isActive =
        idx === currentInteractionIndex && !viewingInitialSnapshot && !viewingFinalSnapshot;
      const actionType = interaction.action.type;
      const actionLabel = actionType.charAt(0).toUpperCase() + actionType.slice(1);
      const time = new Date(interaction.timestamp).toLocaleTimeString();

      return `
      <div class="timeline-item ${isActive ? 'active' : ''}" data-type="interaction" data-index="${idx}">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="timeline-action">${actionLabel}</div>
          <div class="timeline-time">${time}</div>
          ${interaction.action.target.text ? `<div class="timeline-target">${escapeHtml(interaction.action.target.text.substring(0, 30))}${interaction.action.target.text.length > 30 ? '...' : ''}</div>` : ''}
        </div>
      </div>
    `;
    })
  );

  // Load final snapshot data if needed
  let finalSnapshot: Snapshot | null = null;
  if (currentTrace.finalSnapshotId) {
    finalSnapshot = await getSnapshotFromStorage(currentTrace.finalSnapshotId);
  }

  // Add final snapshot item
  if (currentTrace.finalSnapshotId) {
    const isActive = viewingFinalSnapshot;
    const time = finalSnapshot ? new Date(finalSnapshot.capturedAt).toLocaleTimeString() : '';
    const title = finalSnapshot ? finalSnapshot.title : 'Final Page';

    items.push(`
      <div class="timeline-item ${isActive ? 'active' : ''}" data-type="final">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="timeline-action">Final</div>
          <div class="timeline-time">${time}</div>
          <div class="timeline-target">${escapeHtml(title.substring(0, 30))}${title.length > 30 ? '...' : ''}</div>
        </div>
      </div>
    `);
  }

  timelineEl.innerHTML = items.join('');

  // Add click handlers
  timelineEl.querySelectorAll('.timeline-item').forEach((item) => {
    item.addEventListener('click', () => {
      const type = (item as HTMLElement).dataset.type;
      if (type === 'initial') {
        loadInitialSnapshot();
      } else if (type === 'final') {
        loadFinalSnapshot();
      } else if (type === 'interaction') {
        const index = parseInt((item as HTMLElement).dataset.index || '0');
        loadInteraction(index, showingPreAction);
      }
    });
  });

  // Update position indicator
  const positionEl = document.getElementById('trace-position');
  if (positionEl && currentTrace) {
    const totalItems =
      (currentTrace.initialSnapshotId ? 1 : 0) +
      currentTrace.interactions.length +
      (currentTrace.finalSnapshotId ? 1 : 0);
    let currentPosition: number;
    if (viewingInitialSnapshot) {
      currentPosition = 1;
    } else if (viewingFinalSnapshot) {
      currentPosition = totalItems;
    } else {
      currentPosition = (currentTrace.initialSnapshotId ? 1 : 0) + currentInteractionIndex + 1;
    }
    positionEl.textContent = `${currentPosition} / ${totalItems}`;
  }

  // Update pre/post button states and visibility
  const preBtn = document.getElementById('trace-pre-btn');
  const postBtn = document.getElementById('trace-post-btn');
  const toggleContainer = document.querySelector('.trace-snapshot-toggle');

  if (viewingInitialSnapshot || viewingFinalSnapshot) {
    // Hide pre/post buttons for initial/final snapshots
    if (toggleContainer) {
      (toggleContainer as HTMLElement).style.display = 'none';
    }
  } else {
    // Show pre/post buttons for interactions
    if (toggleContainer) {
      (toggleContainer as HTMLElement).style.display = '';
    }
    if (preBtn) {
      preBtn.classList.toggle('active', showingPreAction);
    }
    if (postBtn) {
      postBtn.classList.toggle('active', !showingPreAction);
    }
  }
}

// Navigate to next/previous item in timeline
function navigateInteraction(direction: 'prev' | 'next') {
  if (!currentTrace) return;

  // Handle navigation from initial snapshot
  if (viewingInitialSnapshot) {
    if (direction === 'next') {
      if (currentTrace.interactions.length > 0) {
        loadInteraction(0, showingPreAction);
      } else if (currentTrace.finalSnapshotId) {
        loadFinalSnapshot();
      }
    }
    return;
  }

  // Handle navigation from final snapshot
  if (viewingFinalSnapshot) {
    if (direction === 'prev') {
      if (currentTrace.interactions.length > 0) {
        loadInteraction(currentTrace.interactions.length - 1, showingPreAction);
      } else if (currentTrace.initialSnapshotId) {
        loadInitialSnapshot();
      }
    }
    return;
  }

  // Handle navigation from interactions
  if (direction === 'next') {
    // Check if we should go to final snapshot
    if (currentInteractionIndex === currentTrace.interactions.length - 1) {
      if (currentTrace.finalSnapshotId) {
        loadFinalSnapshot();
      }
    } else {
      loadInteraction(currentInteractionIndex + 1, showingPreAction);
    }
  } else {
    // Check if we should go to initial snapshot
    if (currentInteractionIndex === 0) {
      if (currentTrace.initialSnapshotId) {
        loadInitialSnapshot();
      }
    } else {
      loadInteraction(currentInteractionIndex - 1, showingPreAction);
    }
  }
}

// Load snapshot into preview (direct storage access - no message size limits)
async function loadSnapshot(snapshotId: string) {
  try {
    const snapshot = await getSnapshotFromStorage(snapshotId);
    if (!snapshot) {
      console.error('Snapshot not found:', snapshotId);
      return;
    }

    // Reset marks state when loading new snapshot
    marksEnabled = false;
    detectedMarks = [];
    const marksPanel = document.getElementById('marks-panel');
    if (marksPanel) {
      marksPanel.classList.add('hidden');
    }
    const autoDetectBtn = document.getElementById('auto-detect-btn');
    if (autoDetectBtn) {
      autoDetectBtn.classList.remove('active');
    }

    currentSnapshot = snapshot;

    // Create a default question if none exist
    if (snapshot.questions.length === 0) {
      const defaultQuestion: Question = {
        id: generateId(),
        query: 'Question 1',
        expectedAnswer: '',
        annotationIds: [],
        evaluation: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      snapshot.questions.push(defaultQuestion);
      // Save the snapshot with the new question
      await sendMessage('UPDATE_SNAPSHOT', {
        id: snapshot.id,
        updates: snapshot,
      });
    }

    currentQuestionId = snapshot.questions[0].id;

    updateUI();
  } catch (error) {
    console.error('Failed to load snapshot:', error);
  }
}

// Note: Annotators are destroyed automatically when iframe content is replaced

// Update the entire UI
function updateUI() {
  if (!currentSnapshot) return;

  // Update snapshot navigation active state FIRST (needed for accordion to work)
  updateSnapshotNavActive();

  // Update page title
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    titleEl.textContent = currentSnapshot.title || currentSnapshot.url;
  }

  // Update open URL button
  const openUrlBtn = document.getElementById('open-url-btn') as HTMLAnchorElement;
  if (openUrlBtn && currentSnapshot.url) {
    openUrlBtn.href = currentSnapshot.url;
  }

  // Load iframe with our annotator page
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    // Strip CSP meta tags from HTML
    const htmlWithoutCsp = stripCspFromHtml(currentSnapshot.html);

    // Use our iframe.html page which has the annotator script
    const iframeUrl = chrome.runtime.getURL('iframe.html');

    // Set up message handling before loading iframe
    setupIframeMessageHandler(iframe, htmlWithoutCsp);

    // Load the iframe page
    iframe.src = iframeUrl;
  }

  // Update questions tab list
  updateQuestionsTabList();

  // Update annotation counts
  updateAnnotationCounts();

  // Update annotation list
  renderAnnotationList();

  // Update status
  updateStatusDisplay();

  // Update evaluation form
  updateEvaluationForm();

  // Update current question label
  updateCurrentQuestionLabel();

  // Update questions tab context
  const contextEl = document.getElementById('questions-context');
  if (contextEl && currentSnapshot) {
    contextEl.textContent = `For: ${currentSnapshot.title || 'Untitled'}`;
  }

  // Update questions list in Questions tab
  updateQuestionsTabList();

  // Update review notes
  const notesInput = document.getElementById('review-notes') as HTMLTextAreaElement;
  if (notesInput && currentSnapshot.reviewNotes) {
    notesInput.value = currentSnapshot.reviewNotes;
  }
}

// Track if iframe annotator is ready
let iframeAnnotatorReady = false;
let pendingIframeMessages: Array<{ type: string; payload?: unknown }> = [];
let currentMessageHandler: ((event: MessageEvent) => void) | null = null;

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

// Set up message handler for iframe communication
function setupIframeMessageHandler(iframe: HTMLIFrameElement, htmlContent: string) {
  console.log('Setting up iframe message handler');

  // Reset state
  iframeAnnotatorReady = false;
  pendingIframeMessages = [];

  // Remove previous handler if exists
  if (currentMessageHandler) {
    window.removeEventListener('message', currentMessageHandler);
  }

  // Create message handler
  const messageHandler = (event: MessageEvent) => {
    // Only accept messages from our iframe
    if (event.source !== iframe.contentWindow) return;

    const message = event.data;
    if (!message?.type) return;

    console.log('Message from iframe:', message.type);

    switch (message.type) {
      case 'IFRAME_LOADED':
        // Iframe is ready, send the HTML content
        console.log('Iframe loaded, sending HTML content...');
        iframe.contentWindow?.postMessage(
          {
            type: 'LOAD_HTML',
            payload: { html: htmlContent },
          },
          '*'
        );
        break;

      case 'ANNOTATOR_READY':
        iframeAnnotatorReady = true;
        console.log('Annotator ready');
        // Send any pending messages
        pendingIframeMessages.forEach((msg) => {
          iframe.contentWindow?.postMessage(msg, '*');
        });
        pendingIframeMessages = [];
        // Send current tool state
        sendToIframe(iframe, 'SET_TOOL', currentTool);
        // Load annotations for current question only
        if (currentSnapshot && currentQuestionId) {
          const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
          if (question) {
            const annotationIds = new Set(question.annotationIds);
            // Load text annotations
            const questionTextAnnotations = currentSnapshot.annotations.text.filter((a) =>
              annotationIds.has(a.id)
            );
            console.log(
              'Loading text annotations for question:',
              currentQuestionId,
              'count:',
              questionTextAnnotations.length
            );
            if (questionTextAnnotations.length > 0) {
              const w3cAnnotations = questionTextAnnotations.map((a) => convertToW3CText(a));
              sendToIframe(iframe, 'LOAD_ANNOTATIONS', w3cAnnotations);
            }
            // Load region annotations (image annotators are now in the iframe)
            const questionRegionAnnotations = currentSnapshot.annotations.region.filter((a) =>
              annotationIds.has(a.id)
            );
            console.log(
              'Loading region annotations for question:',
              currentQuestionId,
              'count:',
              questionRegionAnnotations.length
            );
            if (questionRegionAnnotations.length > 0) {
              const regionData = questionRegionAnnotations.map((a) => ({
                id: a.id,
                imageId: a.targetSelector,
                bounds: a.bounds,
                type: a.type,
              }));
              sendToIframe(iframe, 'LOAD_REGION_ANNOTATIONS', regionData);
            }
            // Load element annotations (text annotations with CSS selectors)
            const elementAnnotations = questionTextAnnotations.filter(
              (a) => a.selector.type === 'css'
            );
            if (elementAnnotations.length > 0) {
              // Find their indices in the full list for consistent numbering
              const allAnnotations = [
                ...questionTextAnnotations,
                ...questionRegionAnnotations,
              ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

              const elementData = elementAnnotations.map((a) => {
                const index = allAnnotations.findIndex((ann) => ann.id === a.id) + 1;
                return {
                  id: a.id,
                  selector: a.selector.value,
                  type: a.type,
                  index,
                };
              });
              console.log('Loading element annotations:', elementData);
              sendToIframe(iframe, 'LOAD_ELEMENT_ANNOTATIONS', elementData);
            }

            // Set the annotation index to total count for consistent numbering
            const totalAnnotations =
              questionTextAnnotations.length + questionRegionAnnotations.length;
            sendToIframe(iframe, 'SET_ANNOTATION_INDEX', { index: totalAnnotations });
          }
        }
        break;

      case 'ANNOTATION_CREATED':
        handleAnnotationCreated(message.payload);
        break;

      case 'ANNOTATION_DELETED':
        handleAnnotationDeleted(message.payload);
        break;

      case 'ANNOTATION_CLICKED': {
        const { annotationId } = message.payload as { annotationId: string };
        console.log('[Viewer] Annotation clicked:', annotationId);
        if (annotationId) {
          scrollSidebarToAnnotation(annotationId);
        }
        break;
      }

      case 'KEY_PRESSED': {
        const { key } = message.payload as { key: string };
        if (key === 'r') {
          setTool('relevant');
        } else if (key === 'a') {
          setTool('answer');
        } else if (key === 's') {
          setTool('select');
        }
        break;
      }

      case 'REGION_ANNOTATION_CREATED':
        handleRegionAnnotationCreated(message.payload);
        break;

      case 'REGION_ANNOTATION_DELETED':
        handleRegionAnnotationDeleted(message.payload);
        break;

      // Webmarker messages
      case 'MARKS_DETECTED':
        handleMarksDetected(message.payload as { marks: typeof detectedMarks });
        break;

      case 'MARKS_CLEARED':
        handleMarksCleared();
        break;

      case 'MARK_CLICKED':
        handleMarkClicked(message.payload as { label: string });
        break;
    }
  };

  // Store and attach the handler
  currentMessageHandler = messageHandler;
  window.addEventListener('message', messageHandler);
}

// Handle annotation created from iframe
function handleAnnotationCreated(payload: { annotation: unknown; tool: string }) {
  if (!currentSnapshot) return;

  const { annotation, tool } = payload;
  const textAnnotation = convertFromW3CText(annotation, tool as AnnotationType);

  if (textAnnotation) {
    currentSnapshot.annotations.text.push(textAnnotation);

    if (currentQuestionId) {
      const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
      if (question) {
        question.annotationIds.push(textAnnotation.id);
      }
    }

    updateAnnotationCounts();
    renderAnnotationList();
    // Scroll to and highlight the new annotation in the sidebar
    highlightNewAnnotation(textAnnotation.id);
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

  currentSnapshot.annotations.text = currentSnapshot.annotations.text.filter((a) => a.id !== id);

  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter((aid) => aid !== id);
  }

  updateAnnotationCounts();
  renderAnnotationList();
  saveCurrentSnapshot();
}

// Handle region annotation created from iframe
function handleRegionAnnotationCreated(payload: {
  annotation: unknown;
  tool: string;
  imageId: string;
}) {
  if (!currentSnapshot) return;

  const { annotation, tool, imageId } = payload;
  const regionAnnotation = convertFromW3CRegion(annotation, tool as AnnotationType, imageId);

  if (regionAnnotation) {
    currentSnapshot.annotations.region.push(regionAnnotation);

    if (currentQuestionId) {
      const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
      if (question) {
        question.annotationIds.push(regionAnnotation.id);
      }
    }

    updateAnnotationCounts();
    renderAnnotationList();
    // Scroll to and highlight the new annotation in the sidebar
    highlightNewAnnotation(regionAnnotation.id);
    saveCurrentSnapshot();
    console.log('Region annotation created:', regionAnnotation.id);
  }
}

// Handle marks detected from iframe
function handleMarksDetected(payload: { marks: typeof detectedMarks }) {
  detectedMarks = payload.marks;
  marksEnabled = true;

  // Show the marks panel
  const marksPanel = document.getElementById('marks-panel');
  if (marksPanel) {
    marksPanel.classList.remove('hidden');
  }

  // Update auto-detect button state
  const autoDetectBtn = document.getElementById('auto-detect-btn');
  if (autoDetectBtn) {
    autoDetectBtn.classList.add('active');
  }

  renderMarksList();
  console.log('Marks detected:', detectedMarks.length);
}

// Handle marks cleared from iframe
function handleMarksCleared() {
  detectedMarks = [];
  marksEnabled = false;

  // Hide the marks panel
  const marksPanel = document.getElementById('marks-panel');
  if (marksPanel) {
    marksPanel.classList.add('hidden');
  }

  // Update auto-detect button state
  const autoDetectBtn = document.getElementById('auto-detect-btn');
  if (autoDetectBtn) {
    autoDetectBtn.classList.remove('active');
  }
}

// Handle mark clicked from iframe
function handleMarkClicked(payload: { label: string }) {
  const { label } = payload;
  highlightMarkInList(label);
}

// Highlight a mark in the list
function highlightMarkInList(label: string) {
  const listEl = document.getElementById('marks-list');
  if (!listEl) return;

  // Remove previous active state
  listEl.querySelectorAll('.mark-item').forEach((item) => {
    item.classList.remove('active');
  });

  // Add active state to clicked mark
  const markItem = listEl.querySelector(`.mark-item[data-label="${label}"]`);
  if (markItem) {
    markItem.classList.add('active');
    markItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Delete a detected mark
function deleteMark(label: string) {
  // Remove from detected marks
  detectedMarks = detectedMarks.filter((m) => m.label !== label);

  // Update iframe to remove the mark visual
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    sendToIframe(iframe, 'REMOVE_MARK', { label });
  }

  renderMarksList();

  // Hide panel if no marks left
  if (detectedMarks.length === 0) {
    handleMarksCleared();
  }
}

// Elevate a mark to an annotation (keeps visual bounding box with annotation color)
function elevateMarkToAnnotation(label: string, type?: AnnotationType) {
  if (!currentSnapshot || !currentQuestionId) {
    showNotification('Select a question first to add annotations', 'error');
    return;
  }

  const mark = detectedMarks.find((m) => m.label === label);
  if (!mark) return;

  // Use provided type, or fall back to current tool, or default to 'relevant'
  const annotationType: AnnotationType = type || (currentTool === 'answer' ? 'answer' : 'relevant');

  // Create a text annotation with the element's info
  const textAnnotation: TextAnnotation = {
    id: generateId(),
    type: annotationType,
    startOffset: 0,
    endOffset: 0,
    selectedText: `[${mark.tagName}] ${mark.textPreview}`,
    selector: {
      type: 'css',
      value: mark.selector,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Add to annotations
  currentSnapshot.annotations.text.push(textAnnotation);

  // Link to current question
  const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
  if (question) {
    question.annotationIds.push(textAnnotation.id);
  }

  // Calculate the annotation index (position in current question's annotations)
  const questionAnnotations = getAnnotationsForCurrentQuestion();
  const annotationIndex = questionAnnotations.text.length + questionAnnotations.region.length;

  // Convert the mark visual to annotation style (keeps bounding box with new color and number)
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    sendToIframe(iframe, 'CONVERT_MARK_TO_ANNOTATION', {
      label,
      annotationId: textAnnotation.id,
      annotationType,
      index: annotationIndex,
    });
  }

  // Remove from detected marks list (but visual stays in iframe)
  detectedMarks = detectedMarks.filter((m) => m.label !== label);
  renderMarksList();

  // Hide panel if no marks left
  if (detectedMarks.length === 0) {
    const marksPanel = document.getElementById('marks-panel');
    if (marksPanel) marksPanel.classList.add('hidden');
    const autoDetectBtn = document.getElementById('auto-detect-btn');
    if (autoDetectBtn) autoDetectBtn.classList.remove('active');
    marksEnabled = false;
  }

  // Update UI
  updateAnnotationCounts();
  renderAnnotationList();
  saveCurrentSnapshot();

  showNotification(`Element added as ${annotationType}`, 'success');
}

// Render marks list
function renderMarksList() {
  const listEl = document.getElementById('marks-list');
  const countEl = document.getElementById('marks-count');
  if (!listEl) return;

  // Update count
  if (countEl) {
    countEl.textContent = String(detectedMarks.length);
  }

  if (detectedMarks.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">Click Auto-detect to find interactive elements</div>';
    return;
  }

  listEl.innerHTML = detectedMarks
    .map(
      (mark) => `
    <div class="mark-item" data-label="${mark.label}">
      <span class="mark-number">${mark.label}</span>
      <div class="mark-info">
        <span class="mark-tag">${mark.tagName}</span>
        <span class="mark-text">${escapeHtml(mark.textPreview.substring(0, 25))}${mark.textPreview.length > 25 ? '...' : ''}</span>
      </div>
      <div class="mark-actions">
        <button class="mark-action-btn relevant" data-label="${mark.label}" title="Add as Relevant">
          <span class="action-dot relevant"></span>
        </button>
        <button class="mark-action-btn answer" data-label="${mark.label}" title="Add as Answer">
          <span class="action-dot answer"></span>
        </button>
        <button class="mark-action-btn delete" data-label="${mark.label}" title="Delete">×</button>
      </div>
    </div>
  `
    )
    .join('');

  // Add event handlers for mark items
  listEl.querySelectorAll('.mark-item').forEach((item) => {
    const label = (item as HTMLElement).dataset.label!;

    // Click on item (but not buttons) to highlight
    item.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.mark-action-btn')) return;

      // Highlight in iframe
      const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
      if (iframe) {
        sendToIframe(iframe, 'HIGHLIGHT_MARK', { label });
      }

      // Visual feedback
      listEl.querySelectorAll('.mark-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
    });
  });

  // Add event handlers for annotate buttons
  listEl.querySelectorAll('.mark-action-btn.relevant').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = (btn as HTMLElement).dataset.label!;
      elevateMarkToAnnotation(label, 'relevant');
    });
  });

  listEl.querySelectorAll('.mark-action-btn.answer').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = (btn as HTMLElement).dataset.label!;
      elevateMarkToAnnotation(label, 'answer');
    });
  });

  listEl.querySelectorAll('.mark-action-btn.delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const label = (btn as HTMLElement).dataset.label!;
      deleteMark(label);
    });
  });
}

// Toggle marks detection
function toggleMarks() {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (!iframe) return;

  if (marksEnabled) {
    sendToIframe(iframe, 'DISABLE_MARKS', {});
  } else {
    sendToIframe(iframe, 'ENABLE_MARKS', {});
  }
}

// Clear marks
function clearMarks() {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    sendToIframe(iframe, 'DISABLE_MARKS', {});
  }
}

// Handle region annotation deleted from iframe
function handleRegionAnnotationDeleted(payload: { annotation: unknown; imageId: string }) {
  if (!currentSnapshot) return;

  const annotation = payload.annotation as { id?: string };
  const id = annotation?.id;
  if (!id) return;

  currentSnapshot.annotations.region = currentSnapshot.annotations.region.filter(
    (a) => a.id !== id
  );

  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter((aid) => aid !== id);
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

// Update the visual appearance of an annotation based on its type
function updateAnnotationAppearance(annotationId: string, type: AnnotationType) {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  const doc = iframe?.contentDocument;
  if (!doc) return;

  // Find the annotation element and add the type class
  setTimeout(() => {
    const elements = doc.querySelectorAll(
      `[data-annotation="${annotationId}"], [data-id="${annotationId}"]`
    );
    elements.forEach((el) => {
      el.classList.remove('relevant', 'answer', 'no_content');
      el.classList.add(type);
    });
  }, 50);
}

// Note: Image annotators are now initialized inside the iframe

// Convert our text annotation format to Recogito v3 format
function convertToW3CText(annotation: TextAnnotation): unknown {
  return {
    id: annotation.id,
    bodies: [
      {
        type: 'TextualBody',
        purpose: 'tagging',
        value: annotation.type,
      },
    ],
    target: {
      annotation: annotation.id,
      selector: [
        {
          quote: annotation.selectedText,
          start: annotation.startOffset,
          end: annotation.endOffset,
        },
      ],
    },
  };
}

// Normalize text that spans multiple elements - insert spaces at word boundaries
function normalizeSelectedText(text: string): string {
  // Insert space between lowercase followed by uppercase (e.g., "HomeNews" -> "Home News")
  // This handles text that spans multiple DOM elements with no whitespace
  return (
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      // Also handle numbers followed by letters
      .replace(/([0-9])([A-Za-z])/g, '$1 $2')
      .replace(/([A-Za-z])([0-9])/g, '$1 $2')
  );
}

// Convert W3C text annotation to our format
function convertFromW3CText(w3c: any, type: AnnotationType): TextAnnotation | null {
  try {
    console.log('Converting annotation:', JSON.stringify(w3c, null, 2));

    // Handle Recogito v3 format which uses different field names
    const selectors = w3c.target?.selector;
    let selectedText = '';
    let startOffset = 0;
    let endOffset = 0;

    if (Array.isArray(selectors) && selectors.length > 0) {
      // Recogito v3 format - selector array with quote/start/end
      const selector = selectors[0];
      // Recogito uses 'quote' field for the selected text
      selectedText = selector.quote || selector.exact || '';
      startOffset = selector.start || 0;
      endOffset = selector.end || 0;
    } else if (selectors?.quote) {
      // Single selector with quote
      selectedText = selectors.quote;
      startOffset = selectors.start || 0;
      endOffset = selectors.end || 0;
    } else if (selectors?.exact) {
      // W3C format with exact
      selectedText = selectors.exact;
    }

    if (!selectedText) {
      console.warn('Could not extract selected text from annotation');
      return null;
    }

    // Normalize text that may have been concatenated across DOM elements
    selectedText = normalizeSelectedText(selectedText);

    const annotation: TextAnnotation = {
      id: w3c.id || generateId(),
      type,
      startOffset,
      endOffset,
      selectedText,
      selector: {
        type: 'text-position',
        value: `${startOffset}:${endOffset}`,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    console.log('Converted to:', annotation);
    return annotation;
  } catch (error) {
    console.error('Failed to convert text annotation:', error);
    return null;
  }
}

// Convert W3C region annotation to our format
function convertFromW3CRegion(
  w3c: unknown,
  type: AnnotationType,
  targetSelector: string
): RegionAnnotation | null {
  try {
    console.log('Converting region annotation:', JSON.stringify(w3c, null, 2));

    const annotation = w3c as {
      id?: string;
      target?: {
        selector?: unknown;
      };
    };

    const selector = annotation.target?.selector;
    if (!selector) {
      console.warn('No selector found in region annotation');
      return null;
    }

    // Parse bounds from different selector formats
    let bounds = { x: 0, y: 0, width: 0, height: 0 };

    // Handle array of selectors or single selector
    const selectorArray = Array.isArray(selector) ? selector : [selector];

    for (const sel of selectorArray) {
      const s = sel as {
        type?: string;
        value?: string;
        geometry?: {
          x?: number;
          y?: number;
          w?: number;
          h?: number;
          width?: number;
          height?: number;
          bounds?: { minX: number; minY: number; maxX: number; maxY: number };
        };
      };

      // Annotorious RECTANGLE type - has geometry with x, y, w, h
      if (s.type === 'RECTANGLE' && s.geometry) {
        if (s.geometry.w !== undefined && s.geometry.h !== undefined) {
          bounds = {
            x: s.geometry.x || 0,
            y: s.geometry.y || 0,
            width: s.geometry.w,
            height: s.geometry.h,
          };
          console.log('Extracted bounds from RECTANGLE geometry:', bounds);
          break;
        } else if (s.geometry.bounds) {
          bounds = {
            x: s.geometry.bounds.minX,
            y: s.geometry.bounds.minY,
            width: s.geometry.bounds.maxX - s.geometry.bounds.minX,
            height: s.geometry.bounds.maxY - s.geometry.bounds.minY,
          };
          console.log('Extracted bounds from RECTANGLE bounds:', bounds);
          break;
        }
      }

      // FragmentSelector with xywh format
      if (s.type === 'FragmentSelector' && s.value) {
        const match = s.value.match(/xywh=(?:percent:)?([^,]+),([^,]+),([^,]+),([^,]+)/);
        if (match) {
          bounds = {
            x: parseFloat(match[1]),
            y: parseFloat(match[2]),
            width: parseFloat(match[3]),
            height: parseFloat(match[4]),
          };
          console.log('Extracted bounds from FragmentSelector:', bounds);
          break;
        }
      }

      // SvgSelector - extract from geometry if available
      if (s.type === 'SvgSelector' && s.geometry) {
        if (s.geometry.bounds) {
          bounds = {
            x: s.geometry.bounds.minX,
            y: s.geometry.bounds.minY,
            width: s.geometry.bounds.maxX - s.geometry.bounds.minX,
            height: s.geometry.bounds.maxY - s.geometry.bounds.minY,
          };
        } else {
          bounds = {
            x: s.geometry.x || 0,
            y: s.geometry.y || 0,
            width: s.geometry.width || s.geometry.w || 0,
            height: s.geometry.height || s.geometry.h || 0,
          };
        }
        console.log('Extracted bounds from SvgSelector:', bounds);
        break;
      }
    }

    console.log('Final extracted bounds:', bounds);

    return {
      id: annotation.id || generateId(),
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
  if (!iframe) return;

  // Send message to iframe to scroll to and highlight the annotation
  sendToIframe(iframe, 'SCROLL_TO_ANNOTATION', { annotationId });
}

// Scroll sidebar annotation list to show the annotation
function scrollSidebarToAnnotation(annotationId: string) {
  const listEl = document.getElementById('annotation-list');
  if (!listEl) return;

  console.log('[Viewer] Looking for annotation:', annotationId);
  console.log(
    '[Viewer] Available items:',
    Array.from(listEl.querySelectorAll('.annotation-item')).map(
      (el) => (el as HTMLElement).dataset.id
    )
  );

  // Find the annotation item in the sidebar
  const item = listEl.querySelector(`.annotation-item[data-id="${annotationId}"]`);
  if (item) {
    console.log('[Viewer] Found annotation item, highlighting');
    // Remove previous selection
    listEl.querySelectorAll('.annotation-item').forEach((i) => i.classList.remove('selected'));
    // Add selection to this item
    item.classList.add('selected');
    // Scroll into view
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    console.log('[Viewer] Annotation item not found in list');
  }
}

// Scroll to and highlight a newly added annotation in the sidebar
function highlightNewAnnotation(annotationId: string) {
  const listEl = document.getElementById('annotation-list');
  if (!listEl) return;

  // Find the annotation item in the sidebar
  const item = listEl.querySelector(`.annotation-item[data-id="${annotationId}"]`);
  if (item) {
    // Remove any previous selections and newly-added states
    listEl.querySelectorAll('.annotation-item').forEach((i) => {
      i.classList.remove('selected', 'newly-added');
    });
    // Add highlight class for animation
    item.classList.add('newly-added');
    // Scroll into view
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Sync iframe annotations to show only current question's annotations
function syncIframeAnnotations() {
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (!iframe || !iframeAnnotatorReady) {
    console.log('syncIframeAnnotations: iframe not ready', {
      iframe: !!iframe,
      ready: iframeAnnotatorReady,
    });
    return;
  }

  // Clear all annotations in iframe first
  sendToIframe(iframe, 'CLEAR_ANNOTATIONS', {});
  sendToIframe(iframe, 'CLEAR_REGION_ANNOTATIONS', {});

  // Get annotations for current question
  const { text: textAnnotations, region: regionAnnotations } = getAnnotationsForCurrentQuestion();
  console.log(
    'syncIframeAnnotations: question',
    currentQuestionId,
    'text:',
    textAnnotations.length,
    'region:',
    regionAnnotations.length
  );

  // Load only this question's text annotations
  if (textAnnotations.length > 0) {
    const w3cAnnotations = textAnnotations.map((a) => convertToW3CText(a));
    console.log('syncIframeAnnotations: loading text annotations', w3cAnnotations);
    sendToIframe(iframe, 'LOAD_ANNOTATIONS', w3cAnnotations);
  }

  // Load only this question's region annotations
  if (regionAnnotations.length > 0) {
    const regionData = regionAnnotations.map((a) => ({
      id: a.id,
      imageId: a.targetSelector,
      bounds: a.bounds,
      type: a.type,
    }));
    console.log('syncIframeAnnotations: loading region annotations', regionData);
    sendToIframe(iframe, 'LOAD_REGION_ANNOTATIONS', regionData);
  }

  // Load element annotations (text annotations with CSS selectors)
  const elementAnnotations = textAnnotations.filter((a) => a.selector.type === 'css');
  if (elementAnnotations.length > 0) {
    // Find their indices in the full list for consistent numbering
    const allAnnotations = [...textAnnotations, ...regionAnnotations].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const elementData = elementAnnotations.map((a) => {
      const index = allAnnotations.findIndex((ann) => ann.id === a.id) + 1;
      return {
        id: a.id,
        selector: a.selector.value,
        type: a.type,
        index,
      };
    });
    console.log('syncIframeAnnotations: loading element annotations', elementData);
    sendToIframe(iframe, 'LOAD_ELEMENT_ANNOTATIONS', elementData);
  }

  // Set the annotation index to total count so new annotations continue the sequence
  const totalAnnotations = textAnnotations.length + regionAnnotations.length;
  sendToIframe(iframe, 'SET_ANNOTATION_INDEX', { index: totalAnnotations });
}

// Update annotation counts (for current question)
function updateAnnotationCounts() {
  if (!currentSnapshot) return;

  // Get annotations for current question only
  const { text: textAnnotations, region: regionAnnotations } = getAnnotationsForCurrentQuestion();
  const allAnnotations = [...textAnnotations, ...regionAnnotations];

  const relevantCount = allAnnotations.filter((a) => a.type === 'relevant').length;
  const answerCount = allAnnotations.filter((a) => a.type === 'answer').length;

  // Update right sidebar counts
  const relevantEl = document.getElementById('relevant-count');
  const answerEl = document.getElementById('answer-count');

  if (relevantEl) relevantEl.textContent = String(relevantCount);
  if (answerEl) answerEl.textContent = String(answerCount);

  // Update bottom bar counts
  const bottomRelevantEl = document.getElementById('bottom-relevant-count');
  const bottomAnswerEl = document.getElementById('bottom-answer-count');

  if (bottomRelevantEl) bottomRelevantEl.textContent = String(relevantCount);
  if (bottomAnswerEl) bottomAnswerEl.textContent = String(answerCount);
}

// Get annotations for the current question
function getAnnotationsForCurrentQuestion(): {
  text: TextAnnotation[];
  region: RegionAnnotation[];
} {
  if (!currentSnapshot) {
    return { text: [], region: [] };
  }

  // If no question selected, show no annotations
  if (!currentQuestionId) {
    return { text: [], region: [] };
  }

  const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
  if (!question) {
    return { text: [], region: [] };
  }

  // Filter annotations to only those linked to this question
  const annotationIds = new Set(question.annotationIds);
  console.log('getAnnotationsForCurrentQuestion:', {
    questionId: currentQuestionId,
    annotationIds: Array.from(annotationIds),
    totalTextAnnotations: currentSnapshot.annotations.text.length,
    totalRegionAnnotations: currentSnapshot.annotations.region.length,
  });
  return {
    text: currentSnapshot.annotations.text.filter((a) => annotationIds.has(a.id)),
    region: currentSnapshot.annotations.region.filter((a) => annotationIds.has(a.id)),
  };
}

// Render annotation list
function renderAnnotationList() {
  const listEl = document.getElementById('annotation-list');
  if (!listEl || !currentSnapshot) return;

  // Get annotations for current question only
  const { text: textAnnotations, region: regionAnnotations } = getAnnotationsForCurrentQuestion();

  if (!currentQuestionId) {
    listEl.innerHTML = '<div class="empty-state">Select a question to see its annotations.</div>';
    return;
  }

  if (textAnnotations.length === 0 && regionAnnotations.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">No annotations yet. Select text or draw on images to annotate.</div>';
    return;
  }

  // Combine all annotations with their type and sort by creation time
  const allAnnotations: Array<{
    id: string;
    type: string;
    createdAt: string;
    annotationType: 'text' | 'region';
    displayText: string;
  }> = [];

  for (const a of textAnnotations) {
    allAnnotations.push({
      id: a.id,
      type: a.type,
      createdAt: a.createdAt,
      annotationType: 'text',
      displayText: a.selectedText,
    });
  }

  for (const a of regionAnnotations) {
    allAnnotations.push({
      id: a.id,
      type: a.type,
      createdAt: a.createdAt,
      annotationType: 'region',
      displayText: `[Region: ${a.bounds.width.toFixed(0)}×${a.bounds.height.toFixed(0)}]`,
    });
  }

  // Sort by creation time (oldest first, newest at bottom)
  allAnnotations.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Render sorted annotations with index numbers
  const items = allAnnotations.map((a, idx) => {
    const displayText =
      a.annotationType === 'text'
        ? `${escapeHtml(a.displayText.substring(0, 25))}${a.displayText.length > 25 ? '...' : ''}`
        : a.displayText.substring(0, 25) + (a.displayText.length > 25 ? '...' : '');
    const titleAttr = ` title="${escapeHtml(a.displayText)}"`;

    // Get tag name for element annotations, use type indicator for others
    let tagName = '';
    if (a.annotationType === 'region') {
      tagName = 'region';
    } else {
      tagName = 'text';
    }

    return `
      <div class="annotation-item" data-id="${a.id}" data-type="${a.annotationType}">
        <span class="annotation-index ${a.type}">${idx + 1}</span>
        <div class="annotation-info">
          <span class="annotation-tag">${tagName}</span>
          <span class="annotation-text"${titleAttr}>${displayText.replace(/^\[\w+\]\s*/, '')}</span>
        </div>
        <button class="annotation-delete" data-id="${a.id}" title="Delete">×</button>
      </div>
    `;
  });

  listEl.innerHTML = items.join('');

  // Add click handlers to scroll to annotation
  listEl.querySelectorAll('.annotation-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('annotation-delete')) return;
      const id = (item as HTMLElement).dataset.id;
      if (id) {
        listEl.querySelectorAll('.annotation-item').forEach((i) => i.classList.remove('selected'));
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

  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;

  if (type === 'text') {
    currentSnapshot.annotations.text = currentSnapshot.annotations.text.filter((a) => a.id !== id);
    // Tell iframe to remove the annotation
    if (iframe) {
      sendToIframe(iframe, 'REMOVE_ANNOTATION', { annotationId: id });
    }
  } else {
    // Find the region annotation to get the imageId
    const regionAnn = currentSnapshot.annotations.region.find((a) => a.id === id);
    currentSnapshot.annotations.region = currentSnapshot.annotations.region.filter(
      (a) => a.id !== id
    );
    // Tell iframe to remove the region annotation
    if (iframe) {
      sendToIframe(iframe, 'REMOVE_REGION_ANNOTATION', {
        annotationId: id,
        imageId: regionAnn?.targetSelector,
      });
    }
  }

  // Remove from questions
  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter((aid) => aid !== id);
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
  // Clear all toggle buttons
  document
    .querySelectorAll('#correctness-toggle .toggle-btn, #quick-correctness .quick-btn')
    .forEach((b) => b.classList.remove('active'));
  document
    .querySelectorAll('#in-page-toggle .toggle-btn, #quick-in-page .quick-btn')
    .forEach((b) => b.classList.remove('active'));
  document
    .querySelectorAll('#quality-toggle .toggle-btn, #quick-quality .quick-btn')
    .forEach((b) => b.classList.remove('active'));

  if (!currentSnapshot || !currentQuestionId) return;

  const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
  if (!question) return;

  // Set toggle button active states
  if (question.evaluation.answerCorrectness) {
    document
      .querySelectorAll(
        `#correctness-toggle .toggle-btn[data-value="${question.evaluation.answerCorrectness}"], #quick-correctness .quick-btn[data-value="${question.evaluation.answerCorrectness}"]`
      )
      .forEach((btn) => btn.classList.add('active'));
  }

  if (question.evaluation.answerInPage) {
    document
      .querySelectorAll(
        `#in-page-toggle .toggle-btn[data-value="${question.evaluation.answerInPage}"], #quick-in-page .quick-btn[data-value="${question.evaluation.answerInPage}"]`
      )
      .forEach((btn) => btn.classList.add('active'));
  }

  if (question.evaluation.pageQuality) {
    document
      .querySelectorAll(
        `#quality-toggle .toggle-btn[data-value="${question.evaluation.pageQuality}"], #quick-quality .quick-btn[data-value="${question.evaluation.pageQuality}"]`
      )
      .forEach((btn) => btn.classList.add('active'));
  }
}

// Update current question label
function updateCurrentQuestionLabel() {
  const labelEl = document.getElementById('current-question-label');
  const navLabelEl = document.getElementById('question-nav-label');

  if (!currentSnapshot) {
    if (labelEl) labelEl.textContent = 'No question';
    if (navLabelEl) navLabelEl.textContent = '0 of 0';
    return;
  }

  const questionIdx = currentQuestionId
    ? currentSnapshot.questions.findIndex((q) => q.id === currentQuestionId)
    : -1;
  const totalQuestions = currentSnapshot.questions.length;

  if (questionIdx >= 0 && currentQuestionId) {
    const question = currentSnapshot.questions[questionIdx];
    const shortQuery = question.query.substring(0, 30) + (question.query.length > 30 ? '...' : '');
    if (labelEl) labelEl.textContent = `Q${questionIdx + 1}: ${shortQuery}`;
    if (navLabelEl) navLabelEl.textContent = `Q${questionIdx + 1} of ${totalQuestions}`;
  } else {
    if (labelEl) labelEl.textContent = 'No question selected';
    if (navLabelEl) navLabelEl.textContent = `0 of ${totalQuestions}`;
  }
}

// Update review progress stats
function updateReviewProgress() {
  const progressEl = document.getElementById('review-progress');
  if (!progressEl) return;

  const reviewed = allSnapshots.filter(
    (s) => s.status === 'approved' || s.status === 'declined'
  ).length;
  const total = allSnapshots.length;
  progressEl.textContent = `${reviewed} of ${total} reviewed`;
}

// Update questions list in the Questions tab
function updateQuestionsTabList() {
  const listEl = document.getElementById('questions-list');
  if (!listEl || !currentSnapshot) return;

  if (currentSnapshot.questions.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No questions yet</div>';
    return;
  }

  listEl.innerHTML = currentSnapshot.questions
    .map(
      (q, idx) => `
    <div class="question-item ${q.id === currentQuestionId ? 'active' : ''}" data-id="${q.id}">
      <span class="question-number">Q${idx + 1}</span>
      <span class="question-text">${escapeHtml(q.query.substring(0, 40))}${q.query.length > 40 ? '...' : ''}</span>
      <button class="question-delete" data-id="${q.id}" title="Delete">×</button>
    </div>
  `
    )
    .join('');

  // Update question editor with current question
  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  const expectedInput = document.getElementById('expected-answer-input') as HTMLInputElement;

  if (currentQuestionId) {
    const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
    if (question) {
      if (queryInput) queryInput.value = question.query;
      if (expectedInput) expectedInput.value = question.expectedAnswer;
    }
  } else {
    if (queryInput) queryInput.value = '';
    if (expectedInput) expectedInput.value = '';
  }
}

// Navigate to next/previous question
function navigateQuestion(direction: 'prev' | 'next') {
  if (!currentSnapshot || currentSnapshot.questions.length === 0) return;

  const currentIdx = currentQuestionId
    ? currentSnapshot.questions.findIndex((q) => q.id === currentQuestionId)
    : -1;

  let newIdx: number;
  if (direction === 'next') {
    newIdx = currentIdx < currentSnapshot.questions.length - 1 ? currentIdx + 1 : 0;
  } else {
    newIdx = currentIdx > 0 ? currentIdx - 1 : currentSnapshot.questions.length - 1;
  }

  currentQuestionId = currentSnapshot.questions[newIdx].id;
  updateEvaluationForm();
  updateCurrentQuestionLabel();
  updateAnnotationCounts();
  renderAnnotationList();
  updateQuestionsTabList();
  syncIframeAnnotations();
}

// Track save status timeout for cleanup
let saveStatusTimeout: ReturnType<typeof setTimeout> | null = null;

// Show save status indicator
function showSaveStatus(status: 'saving' | 'saved') {
  const statusEl = document.getElementById('save-status');
  if (!statusEl) return;

  // Clear any pending timeout
  if (saveStatusTimeout) {
    clearTimeout(saveStatusTimeout);
    saveStatusTimeout = null;
  }

  statusEl.classList.remove('hidden', 'saving');

  if (status === 'saving') {
    statusEl.textContent = 'Saving...';
    statusEl.classList.add('saving');
  } else {
    statusEl.textContent = 'Saved';
    // Hide after 2 seconds
    saveStatusTimeout = setTimeout(() => {
      statusEl.classList.add('hidden');
    }, 2000);
  }
}

// Save current snapshot (silent by default, showNotification for explicit saves)
async function saveCurrentSnapshot(showConfirmation = false) {
  if (!currentSnapshot) return;

  currentSnapshot.updatedAt = new Date().toISOString();

  showSaveStatus('saving');

  try {
    await sendMessage('UPDATE_SNAPSHOT', {
      id: currentSnapshot.id,
      updates: currentSnapshot,
    });
    showSaveStatus('saved');
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
      filtered = snapshots.filter((s) => s.status === 'pending');
    } else if (filter === 'approved') {
      filtered = snapshots.filter((s) => s.status === 'approved' || s.status === 'declined');
    }

    renderSnapshotNav(filtered);
    updateReviewProgress();
  } catch (error) {
    console.error('Failed to load snapshots:', error);
  }
}

// Update the current snapshot's summary in allSnapshots (for question count, etc.)
function updateCurrentSnapshotSummary() {
  if (!currentSnapshot) return;

  const index = allSnapshots.findIndex((s) => s.id === currentSnapshot!.id);
  if (index >= 0) {
    allSnapshots[index] = {
      ...allSnapshots[index],
      questionCount: currentSnapshot.questions.length,
      status: currentSnapshot.status,
    };

    // Re-render just the updated item in the nav
    const navItem = document.querySelector(`#snapshot-nav li[data-id="${currentSnapshot.id}"]`);
    if (navItem) {
      const metaEl = navItem.querySelector('.snapshot-meta span:last-child');
      if (metaEl) {
        metaEl.textContent = `${currentSnapshot.questions.length} Q`;
      }
      // Update status dot
      const dotEl = navItem.querySelector('.status-dot');
      if (dotEl) {
        dotEl.className = `status-dot ${currentSnapshot.status}`;
      }
    }
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
        <div class="snapshot-row">
          <span class="snapshot-title">${escapeHtml(s.title || 'Untitled')}</span>
          <span class="status-dot ${s.status}"></span>
        </div>
        <div class="snapshot-meta">
          <span>${formatDate(s.capturedAt)}</span>
          <span>${s.questionCount} Q</span>
        </div>
      </li>
    `
    )
    .join('');

  // Add click handlers for navigation
  navEl.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => {
      const id = (li as HTMLElement).dataset.id;
      if (id && id !== currentSnapshot?.id) {
        window.history.pushState({}, '', `?id=${id}`);
        loadSnapshot(id);
      }
    });

    // Right-click to delete
    li.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const id = (li as HTMLElement).dataset.id;
      if (id) {
        const snapshot = allSnapshots.find((s) => s.id === id);
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
      currentSnapshot = null;
      const remaining = allSnapshots.filter((s) => s.id !== id);
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

  updateQuestionsTabList();
  updateCurrentQuestionLabel();
  updateEvaluationForm();
  // Update annotation list and counts for the new (empty) question
  updateAnnotationCounts();
  renderAnnotationList();
  // Clear annotations from iframe (new question has no annotations yet)
  syncIframeAnnotations();
  // Update sidebar to show new question count
  updateCurrentSnapshotSummary();
  saveCurrentSnapshot();

  // Focus the query input in the Questions tab
  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  queryInput?.focus();
}

// Set tool
function setTool(tool: 'select' | AnnotationType) {
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
  const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
  btn?.classList.add('active');

  // Notify iframe annotator of tool change (handles both text and image annotators)
  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    sendToIframe(iframe, 'SET_TOOL', tool);
  }
}

// Set evaluation value
function setEvaluationValue(name: string, value: string) {
  if (!currentSnapshot || !currentQuestionId) return;
  const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
  if (!question) return;

  // Update data
  if (name === 'correctness') {
    question.evaluation.answerCorrectness = value as AnswerCorrectness;
  } else if (name === 'in-page') {
    question.evaluation.answerInPage = value as AnswerInPage;
  } else if (name === 'quality') {
    question.evaluation.pageQuality = value as PageQuality;
  }

  // Update UI
  updateEvaluationForm();
  saveCurrentSnapshot();
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Skip if in input fields
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA' ||
      (e.target as HTMLElement).tagName === 'SELECT'
    ) {
      return;
    }

    // Handle Ctrl/Cmd shortcuts first (before single-key shortcuts)
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
          const nextPending = allSnapshots.find(
            (s) => s.status === 'pending' && s.id !== currentSnapshot?.id
          );
          if (nextPending) {
            loadSnapshot(nextPending.id);
          }
        }
      }
      // Don't process single-key shortcuts when modifier is held
      return;
    }

    // Annotation tools (only when no modifier keys)
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

    // Trace navigation shortcuts (when in trace mode)
    if (traceMode && currentTrace) {
      if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault();
        navigateInteraction('next');
        return;
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault();
        navigateInteraction('prev');
        return;
      }
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
      } else if (e.key === 'u') {
        e.preventDefault();
        setEvaluationValue('in-page', 'unclear');
      }

      if (e.key === 'g') {
        e.preventDefault();
        setEvaluationValue('quality', 'good');
      } else if (e.key === 'b') {
        e.preventDefault();
        setEvaluationValue('quality', 'broken');
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
  const traceId = params.get('traceId');

  setupKeyboardShortcuts();

  // Theme toggle
  document.getElementById('toggle-theme')?.addEventListener('click', () => {
    const html = document.documentElement;
    const currentTheme = html.dataset.theme || 'pastel';
    html.dataset.theme = currentTheme === 'noir' ? 'pastel' : 'noir';
    localStorage.setItem('refine-page-theme', html.dataset.theme);
  });

  // Load saved theme
  const savedTheme = localStorage.getItem('refine-page-theme');
  if (savedTheme) {
    document.documentElement.dataset.theme = savedTheme;
  }

  // Focus mode toggle
  document.getElementById('toggle-focus-mode')?.addEventListener('click', () => {
    focusMode = !focusMode;
    document.body.classList.toggle('focus-mode', focusMode);
  });

  // Auto-detect button (webmarker)
  document.getElementById('auto-detect-btn')?.addEventListener('click', toggleMarks);

  // Clear marks button
  document.getElementById('clear-marks-btn')?.addEventListener('click', clearMarks);

  // Tab switching (Pages/Questions)
  document.querySelectorAll('.tab-btn[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab;

      // Update tab buttons
      document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      // Update tab content
      document.getElementById('pages-tab')?.classList.toggle('hidden', tabName !== 'pages');
      document.getElementById('questions-tab')?.classList.toggle('hidden', tabName !== 'questions');
    });
  });

  // Check if we're loading a trace (after setting up UI handlers)
  if (traceId) {
    await loadTrace(traceId);
  } else {
    // Normal snapshot loading
    await loadAllSnapshots();

    if (snapshotId) {
      await loadSnapshot(snapshotId);
    } else if (allSnapshots.length > 0) {
      await loadSnapshot(allSnapshots[0].id);
    }
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
      document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const filter = (tab as HTMLElement).dataset.filter || 'all';
      loadAllSnapshots(filter);
    });
  });

  // Toggle-style evaluation buttons (right sidebar)
  document.querySelectorAll('#correctness-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('correctness', value);
    });
  });

  document.querySelectorAll('#in-page-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('in-page', value);
    });
  });

  document.querySelectorAll('#quality-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('quality', value);
    });
  });

  // Quick eval buttons (bottom bar)
  document.querySelectorAll('#quick-correctness .quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('correctness', value);
    });
  });

  document.querySelectorAll('#quick-in-page .quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('in-page', value);
    });
  });

  document.querySelectorAll('#quick-quality .quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = (btn as HTMLElement).dataset.value;
      if (value) setEvaluationValue('quality', value);
    });
  });

  // Question navigation (bottom bar)
  document
    .getElementById('prev-question')
    ?.addEventListener('click', () => navigateQuestion('prev'));
  document
    .getElementById('next-question')
    ?.addEventListener('click', () => navigateQuestion('next'));

  // Trace navigation
  document
    .getElementById('trace-prev-btn')
    ?.addEventListener('click', () => navigateInteraction('prev'));
  document
    .getElementById('trace-next-btn')
    ?.addEventListener('click', () => navigateInteraction('next'));

  // Pre/Post snapshot toggle
  document.getElementById('trace-pre-btn')?.addEventListener('click', () => {
    if (!showingPreAction) {
      loadInteraction(currentInteractionIndex, true);
    }
  });
  document.getElementById('trace-post-btn')?.addEventListener('click', () => {
    if (showingPreAction) {
      loadInteraction(currentInteractionIndex, false);
    }
  });

  // Approve/Decline/Skip buttons
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

  document.getElementById('skip-btn')?.addEventListener('click', () => {
    // Move to next pending snapshot
    const nextPending = allSnapshots.find(
      (s) => s.status === 'pending' && s.id !== currentSnapshot?.id
    );
    if (nextPending) {
      window.history.pushState({}, '', `?id=${nextPending.id}`);
      loadSnapshot(nextPending.id);
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

  // Questions tab handlers
  document.getElementById('add-question-btn')?.addEventListener('click', () => {
    addQuestion();
  });

  // Question editor inputs (in Questions tab)
  const queryInput = document.getElementById('query-input') as HTMLTextAreaElement;
  queryInput?.addEventListener('input', () => {
    if (!currentSnapshot || !currentQuestionId) return;
    const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
    if (question) {
      question.query = queryInput.value;
      question.updatedAt = new Date().toISOString();
      updateCurrentQuestionLabel();
      updateQuestionsTabList();
      saveCurrentSnapshot();
    }
  });

  const expectedInput = document.getElementById('expected-answer-input') as HTMLInputElement;
  expectedInput?.addEventListener('input', () => {
    if (!currentSnapshot || !currentQuestionId) return;
    const question = currentSnapshot.questions.find((q) => q.id === currentQuestionId);
    if (question) {
      question.expectedAnswer = expectedInput.value;
      question.updatedAt = new Date().toISOString();
      saveCurrentSnapshot();
    }
  });

  // Questions list click handlers (event delegation)
  document.getElementById('questions-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Handle delete button
    if (target.classList.contains('question-delete')) {
      const id = target.dataset.id;
      if (id && currentSnapshot) {
        currentSnapshot.questions = currentSnapshot.questions.filter((q) => q.id !== id);
        if (currentQuestionId === id) {
          currentQuestionId = currentSnapshot.questions[0]?.id || null;
        }
        updateUI();
        saveCurrentSnapshot();
      }
      return;
    }

    // Handle question item click
    const questionItem = target.closest('.question-item') as HTMLElement;
    if (questionItem) {
      const id = questionItem.dataset.id;
      if (id) {
        currentQuestionId = id;
        updateQuestionsTabList();
        updateEvaluationForm();
        updateCurrentQuestionLabel();
        updateAnnotationCounts();
        renderAnnotationList();
        syncIframeAnnotations();
      }
    }
  });
});
