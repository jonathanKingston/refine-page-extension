/**
 * Viewer page for annotating and labeling snapshots
 */

import type {
  Snapshot,
  Question,
  TextAnnotation,
  AnnotationType,
  AnswerCorrectness,
  AnswerInPage,
  PageQuality,
} from '@/types';

// State
let currentSnapshot: Snapshot | null = null;
let currentQuestionId: string | null = null;
let currentTool: 'select' | AnnotationType = 'select';
let zoomLevel = 100;
let allSnapshots: Snapshot[] = [];

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

// Get URL parameters
function getUrlParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// Load snapshot into preview
async function loadSnapshot(snapshotId: string) {
  try {
    const snapshot = await sendMessage<Snapshot>('GET_SNAPSHOT', { id: snapshotId });
    if (!snapshot) {
      console.error('Snapshot not found:', snapshotId);
      return;
    }

    currentSnapshot = snapshot;
    updateUI();
  } catch (error) {
    console.error('Failed to load snapshot:', error);
  }
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

    // Set up selection handling after iframe loads
    iframe.onload = () => {
      setupIframeSelection(iframe);
      renderAnnotationsInIframe(iframe);
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

  // Update snapshot navigation active state
  updateSnapshotNavActive();
}

// Setup text selection in iframe
function setupIframeSelection(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc) return;

  doc.addEventListener('mouseup', () => {
    if (currentTool === 'select') return;

    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    // Create annotation
    const range = selection.getRangeAt(0);
    const annotation: TextAnnotation = {
      id: generateId(),
      type: currentTool as AnnotationType,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      selectedText,
      selector: {
        type: 'text-position',
        value: getTextPosition(range, doc),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Add to current snapshot
    if (currentSnapshot) {
      currentSnapshot.annotations.text.push(annotation);

      // Link to current question if one is selected
      if (currentQuestionId) {
        const question = currentSnapshot.questions.find(q => q.id === currentQuestionId);
        if (question) {
          question.annotationIds.push(annotation.id);
        }
      }

      // Update UI
      updateAnnotationCounts();
      renderAnnotationList();
      renderAnnotationsInIframe(iframe);

      // Auto-save
      saveCurrentSnapshot();
    }

    // Clear selection
    selection.removeAllRanges();
  });
}

// Get text position for selector
function getTextPosition(range: Range, doc: Document): string {
  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  let offset = 0;
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node === range.startContainer) {
      return `${offset + range.startOffset}:${offset + range.endOffset}`;
    }
    offset += (node.textContent?.length || 0);
  }

  return `0:0`;
}

// Render annotations as highlights in iframe
function renderAnnotationsInIframe(iframe: HTMLIFrameElement) {
  const doc = iframe.contentDocument;
  if (!doc || !currentSnapshot) return;

  // Remove existing highlights
  doc.querySelectorAll('.pl-highlight').forEach(el => {
    const parent = el.parentNode;
    if (parent) {
      parent.replaceChild(doc.createTextNode(el.textContent || ''), el);
      parent.normalize();
    }
  });

  // Add highlights for each annotation
  for (const annotation of currentSnapshot.annotations.text) {
    highlightText(doc, annotation);
  }
}

// Highlight text in document
function highlightText(doc: Document, annotation: TextAnnotation) {
  // Simple implementation - find and highlight the text
  const walker = doc.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    const index = text.indexOf(annotation.selectedText);
    if (index !== -1) {
      const range = doc.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + annotation.selectedText.length);

      const highlight = doc.createElement('mark');
      highlight.className = `pl-highlight pl-${annotation.type}`;
      highlight.style.backgroundColor = getAnnotationColor(annotation.type);
      highlight.style.padding = '2px';
      highlight.style.borderRadius = '2px';
      highlight.dataset.annotationId = annotation.id;

      try {
        range.surroundContents(highlight);
      } catch {
        // Range may span multiple nodes
      }
      break;
    }
  }
}

// Get annotation color
function getAnnotationColor(type: AnnotationType): string {
  switch (type) {
    case 'relevant':
      return 'rgba(34, 197, 94, 0.3)';
    case 'answer':
      return 'rgba(59, 130, 246, 0.3)';
    case 'no_content':
      return 'rgba(156, 163, 175, 0.3)';
    default:
      return 'rgba(156, 163, 175, 0.3)';
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

  const relevantCount = currentSnapshot.annotations.text.filter(a => a.type === 'relevant').length;
  const answerCount = currentSnapshot.annotations.text.filter(a => a.type === 'answer').length;

  const relevantEl = document.getElementById('relevant-count');
  const answerEl = document.getElementById('answer-count');

  if (relevantEl) relevantEl.textContent = String(relevantCount);
  if (answerEl) answerEl.textContent = String(answerCount);
}

// Render annotation list
function renderAnnotationList() {
  const listEl = document.getElementById('annotation-list');
  if (!listEl || !currentSnapshot) return;

  const annotations = currentSnapshot.annotations.text;

  if (annotations.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No annotations yet. Select text in the preview to annotate.</div>';
    return;
  }

  listEl.innerHTML = annotations
    .map(
      (a) => `
      <div class="annotation-item" data-id="${a.id}">
        <span class="type-indicator ${a.type}"></span>
        <span class="annotation-text">${escapeHtml(a.selectedText)}</span>
        <button class="annotation-delete" data-id="${a.id}" title="Delete">×</button>
      </div>
    `
    )
    .join('');

  // Add delete handlers
  listEl.querySelectorAll('.annotation-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      if (id) deleteAnnotation(id);
    });
  });
}

// Delete annotation
function deleteAnnotation(id: string) {
  if (!currentSnapshot) return;

  currentSnapshot.annotations.text = currentSnapshot.annotations.text.filter(a => a.id !== id);

  // Remove from questions
  for (const question of currentSnapshot.questions) {
    question.annotationIds = question.annotationIds.filter(aid => aid !== id);
  }

  // Update UI
  updateAnnotationCounts();
  renderAnnotationList();

  const iframe = document.getElementById('preview-frame') as HTMLIFrameElement;
  if (iframe) {
    renderAnnotationsInIframe(iframe);
  }

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

// Save current snapshot
async function saveCurrentSnapshot() {
  if (!currentSnapshot) return;

  currentSnapshot.updatedAt = new Date().toISOString();

  try {
    await sendMessage('UPDATE_SNAPSHOT', {
      id: currentSnapshot.id,
      updates: currentSnapshot,
    });
  } catch (error) {
    console.error('Failed to save snapshot:', error);
  }
}

// Load all snapshots for navigation
async function loadAllSnapshots(filter: string = 'all') {
  try {
    const snapshots = await sendMessage<Snapshot[]>('GET_ALL_SNAPSHOTS');
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
function renderSnapshotNav(snapshots: Snapshot[]) {
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
        <div class="nav-item-title">${escapeHtml(s.title || 'Untitled')}</div>
        <div class="nav-item-meta">
          <span>${formatDate(s.capturedAt)}</span>
          <span class="status-badge ${s.status}">${s.status}</span>
        </div>
      </li>
    `
    )
    .join('');

  // Add click handlers
  navEl.querySelectorAll('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => {
      const id = (li as HTMLElement).dataset.id;
      if (id) {
        window.history.pushState({}, '', `?id=${id}`);
        loadSnapshot(id);
      }
    });
  });
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
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  const params = getUrlParams();
  const snapshotId = params.get('id');

  // Load snapshot list
  await loadAllSnapshots();

  // Load specific snapshot if ID provided
  if (snapshotId) {
    await loadSnapshot(snapshotId);
  } else if (allSnapshots.length > 0) {
    // Load first snapshot
    await loadSnapshot(allSnapshots[0].id);
  }

  // Tool buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = (btn as HTMLElement).dataset.tool as typeof currentTool;
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
  document.getElementById('save-btn')?.addEventListener('click', saveCurrentSnapshot);

  // Submit button (same as save for now)
  document.getElementById('submit-btn')?.addEventListener('click', saveCurrentSnapshot);

  // Back button
  document.getElementById('back-btn')?.addEventListener('click', () => {
    window.close();
  });
});

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
