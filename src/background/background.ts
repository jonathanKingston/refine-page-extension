/**
 * Background service worker for refine.page extension
 * Handles cross-component communication, storage operations, and page capture via Chrome MHTML API
 */

import type {
  Snapshot,
  ExportData,
  ExportedSnapshot,
  Trace,
  InteractionRecord,
  CaptureConfig,
} from '@/types';

// Generate unique ID
function generateId(): string {
  return `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Inject a content script and send a message, with automatic retry.
 * This replaces arbitrary delays with actual response checking.
 */
async function injectAndMessage<T>(
  tabId: number,
  scriptFile: string,
  message: { type: string; payload?: unknown },
  maxRetries = 5
): Promise<T> {
  // First try without injecting (script might already be loaded)
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response as T;
  } catch {
    // Script not loaded, inject it
    console.log(`refine.page: Script not loaded, injecting ${scriptFile} into tab ${tabId}`);
  }

  // Inject the script
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [scriptFile],
    });
    console.log(`refine.page: Injected ${scriptFile} successfully`);
  } catch (injectError) {
    console.error(`refine.page: Failed to inject ${scriptFile}:`, injectError);
    throw new Error(`Script injection failed for ${scriptFile}: ${(injectError as Error).message}`);
  }

  // Retry with exponential backoff (20, 40, 80, 160, 320ms = max 620ms total)
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response as T;
    } catch {
      if (retry === maxRetries - 1) {
        throw new Error(`Content script '${scriptFile}' not responding after ${maxRetries} retries`);
      }
      await new Promise((r) => setTimeout(r, 20 * Math.pow(2, retry)));
    }
  }
  throw new Error('Unreachable');
}

// Offscreen document management
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreen: Promise<void> | null = null;
let offscreenReadyResolve: (() => void) | null = null;

// Wait for the offscreen document to signal it's ready
function waitForOffscreenReady(): Promise<void> {
  return new Promise((resolve) => {
    offscreenReadyResolve = resolve;
    // Fallback timeout in case the ready message is missed (e.g., already sent)
    setTimeout(() => {
      if (offscreenReadyResolve) {
        offscreenReadyResolve();
        offscreenReadyResolve = null;
      }
    }, 100);
  });
}

// Handle offscreen ready message
function handleOffscreenReady() {
  if (offscreenReadyResolve) {
    offscreenReadyResolve();
    offscreenReadyResolve = null;
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  // Check if offscreen document already exists (it should persist between captures)
  if (await hasOffscreenDocument()) {
    return;
  }

  // Avoid race conditions by checking if we're already creating
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  // Create offscreen document - it will persist until the extension is reloaded
  // or Chrome decides to close it due to inactivity (rare)
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Convert MHTML to HTML using DOM parser',
  });

  try {
    await creatingOffscreen;
    // Wait for the offscreen document to signal it's ready
    // The offscreen script sends OFFSCREEN_READY when its message listener is registered
    await waitForOffscreenReady();
  } finally {
    creatingOffscreen = null;
  }
}

// Capture page using Chrome's MHTML API and convert to HTML via offscreen document
async function capturePageAsMhtml(
  tabId: number,
  pageUrl: string
): Promise<{ html: string; title: string }> {
  console.log('refine.page: Capturing page as MHTML for tab', tabId, 'url:', pageUrl);
  const startTime = Date.now();

  // Capture the page as MHTML (with retry for flaky Chromium behavior)
  let mhtmlBlob: Blob | undefined;
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mhtmlBlob = await chrome.pageCapture.saveAsMHTML({ tabId });
      if (mhtmlBlob) break;
    } catch (mhtmlError) {
      lastError = mhtmlError as Error;
      console.warn(`refine.page: pageCapture.saveAsMHTML attempt ${attempt + 1} failed:`, mhtmlError);
      // Brief yield before retry
      await new Promise(r => setTimeout(r, 50));
    }
  }
  
  if (!mhtmlBlob) {
    throw new Error(`MHTML capture failed after 3 attempts: ${lastError?.message || 'no blob returned'}`);
  }

  console.log('refine.page: MHTML captured, size:', (mhtmlBlob.size / 1024).toFixed(1), 'KB');

  // Read the MHTML blob as text
  const mhtmlText = await mhtmlBlob.text();

  // Ensure offscreen document exists
  await ensureOffscreenDocument();

  // Send MHTML to offscreen document for conversion
  console.log('refine.page: Sending MHTML to offscreen document for conversion...');
  const response = await chrome.runtime.sendMessage({
    type: 'CONVERT_MHTML',
    payload: { mhtmlText, baseUrl: pageUrl },
  });

  if (!response) {
    throw new Error('No response from offscreen document - it may not have loaded yet');
  }

  if (response.type === 'CONVERT_MHTML_ERROR') {
    throw new Error(response.payload.error);
  }

  const duration = Date.now() - startTime;
  console.log(
    `refine.page: Capture complete in ${duration}ms, HTML size: ${(response.payload.html.length / 1024).toFixed(1)}KB`
  );

  return { html: response.payload.html, title: response.payload.title };
}

// Storage operations using chrome.storage.local
async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const key = `snapshot_${snapshot.id}`;
  
  // Batch storage operations: get index and save both snapshot and index in one operation
  const indexResult = await chrome.storage.local.get(['snapshotIndex', key]);
  const index: string[] = indexResult.snapshotIndex || [];
  const updates: Record<string, unknown> = { [key]: snapshot };
  
  if (!index.includes(snapshot.id)) {
    index.push(snapshot.id);
    updates.snapshotIndex = index;
  }
  
  // Save snapshot and index in a single operation
  await chrome.storage.local.set(updates);
}

async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const key = `snapshot_${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key];
}

// Lightweight snapshot summary for listing (excludes HTML to avoid message size limits)
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

async function getAllSnapshots(): Promise<Snapshot[]> {
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];

  const snapshots: Snapshot[] = [];
  for (const id of index) {
    const snapshot = await getSnapshot(id);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }

  return snapshots.sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
  );
}

// Get lightweight summaries for listing - avoids 64MB message limit
async function getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];

  const summaries: SnapshotSummary[] = [];
  for (const id of index) {
    const snapshot = await getSnapshot(id);
    if (snapshot) {
      summaries.push({
        id: snapshot.id,
        url: snapshot.url,
        title: snapshot.title,
        status: snapshot.status,
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.updatedAt,
        tags: snapshot.tags,
        annotationCount: {
          text: snapshot.annotations.text.length,
          region: snapshot.annotations.region.length,
        },
        questionCount: snapshot.questions.length,
      });
    }
  }

  return summaries.sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
  );
}

async function deleteSnapshot(id: string): Promise<void> {
  const key = `snapshot_${id}`;
  await chrome.storage.local.remove(key);

  // Update the index
  const indexResult = await chrome.storage.local.get('snapshotIndex');
  const index: string[] = indexResult.snapshotIndex || [];
  const newIndex = index.filter((i) => i !== id);
  await chrome.storage.local.set({ snapshotIndex: newIndex });
}

async function updateSnapshot(
  id: string,
  updates: Partial<Snapshot>
): Promise<Snapshot | undefined> {
  const existing = await getSnapshot(id);
  if (!existing) return undefined;

  const updated: Snapshot = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await saveSnapshot(updated);
  return updated;
}

// Export all data
async function exportAllData(): Promise<ExportData> {
  const snapshots = await getAllSnapshots();
  const extensionId = chrome.runtime.id;
  const baseViewerUrl = chrome.runtime.getURL('viewer.html');

  // Add viewer URLs to each snapshot
  const exportedSnapshots: ExportedSnapshot[] = snapshots.map((snapshot) => ({
    ...snapshot,
    viewerUrl: `${baseViewerUrl}?id=${snapshot.id}`,
  }));

  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    extensionId,
    snapshots: exportedSnapshots,
  };
}

// Import data
async function importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const snapshot of data.snapshots) {
    const existing = await getSnapshot(snapshot.id);
    if (existing) {
      skipped++;
    } else {
      await saveSnapshot(snapshot);
      imported++;
    }
  }

  return { imported, skipped };
}

// Recording state management
interface RecordingState {
  isRecording: boolean;
  currentTraceId: string | null;
  config: CaptureConfig | null;
}

async function getRecordingState(): Promise<RecordingState> {
  const result = await chrome.storage.local.get('recordingState');
  return (
    result.recordingState || {
      isRecording: false,
      currentTraceId: null,
      config: null,
    }
  );
}

async function setRecordingState(state: RecordingState): Promise<void> {
  await chrome.storage.local.set({ recordingState: state });
}

// Trace storage operations
async function saveTrace(trace: Trace): Promise<void> {
  const key = `trace_${trace.id}`;
  await chrome.storage.local.set({ [key]: trace });

  // Update the trace index
  const indexResult = await chrome.storage.local.get('traceIndex');
  const index: string[] = indexResult.traceIndex || [];
  if (!index.includes(trace.id)) {
    index.push(trace.id);
    await chrome.storage.local.set({ traceIndex: index });
  }
}

async function getTrace(id: string): Promise<Trace | undefined> {
  const key = `trace_${id}`;
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function getAllTraces(): Promise<Trace[]> {
  const indexResult = await chrome.storage.local.get('traceIndex');
  const index: string[] = indexResult.traceIndex || [];

  const traces: Trace[] = [];
  for (const id of index) {
    const trace = await getTrace(id);
    if (trace) {
      traces.push(trace);
    }
  }

  return traces.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

async function deleteTrace(id: string): Promise<void> {
  const key = `trace_${id}`;
  await chrome.storage.local.remove(key);

  // Update the index
  const indexResult = await chrome.storage.local.get('traceIndex');
  const index: string[] = indexResult.traceIndex || [];
  const newIndex = index.filter((i) => i !== id);
  await chrome.storage.local.set({ traceIndex: newIndex });
}

// Start recording
async function startRecording(config?: CaptureConfig): Promise<{ traceId: string }> {
  const state = await getRecordingState();
  if (state.isRecording) {
    throw new Error('Recording already in progress');
  }

  const defaultConfig: CaptureConfig = {
    navigation: true,
    clicks: true,
    formSubmissions: true,
    textInput: true,
    selections: true,
    scrollThreshold: null,
    hoverDuration: null,
  };

  const traceId = generateTraceId();
  const trace: Trace = {
    id: traceId,
    startedAt: new Date().toISOString(),
    config: config || defaultConfig,
    interactions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await saveTrace(trace);

  await setRecordingState({
    isRecording: true,
    currentTraceId: traceId,
    config: config || defaultConfig,
  });

  // Inject recording script and notify all tabs to start recording
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      try {
        // Try to inject recording script if not already loaded
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['recording.js'],
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          // Script might already be loaded, continue
        }
        
        await chrome.tabs.sendMessage(tab.id, {
          type: 'START_RECORDING',
          payload: { config: config || defaultConfig },
        });
      } catch {
        // Tab might not be accessible, ignore
      }
    }
  }

  // Listen for tab updates and new tabs
  chrome.tabs.onUpdated.addListener(handleTabUpdate);
  chrome.tabs.onCreated.addListener(handleTabCreated);

  // Capture initial snapshot from active tab (excluding extension pages)
  // This runs in the background to not block the recording start
  const captureInitialPromise = (async () => {
    try {
      console.log('[Recording] Looking for active tab for initial snapshot...');
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      console.log('[Recording] Found tabs in lastFocusedWindow:', tabs.map(t => t.url?.substring(0, 50)));
      
      let activeTab = tabs.find(t => 
        t.url && 
        !t.url.startsWith('chrome://') && 
        !t.url.startsWith('chrome-extension://')
      );
      
      // If no capturable tab in focused window, try all windows
      if (!activeTab) {
        console.log('[Recording] No capturable tab in focused window, trying all windows...');
        const allTabs = await chrome.tabs.query({ active: true });
        console.log('[Recording] Found all active tabs:', allTabs.map(t => t.url?.substring(0, 50)));
        activeTab = allTabs.find(t => 
          t.url && 
          !t.url.startsWith('chrome://') && 
          !t.url.startsWith('chrome-extension://')
        );
      }
      
      if (activeTab?.id && activeTab?.url) {
        console.log('[Recording] Capturing initial snapshot from:', activeTab.url);
        await captureInitialSnapshot(activeTab.id, traceId);
        console.log('[Recording] Initial snapshot captured successfully');
      } else {
        console.log('[Recording] No capturable tab found for initial snapshot');
      }
    } catch (error) {
      console.warn('[Recording] Could not capture initial snapshot:', error);
    }
  })();
  
  // Don't await the capture - let it run in background
  // The trace will be updated when the capture completes
  captureInitialPromise.catch(() => {}); // Suppress unhandled rejection

  return { traceId };
}

// Handle new tabs being created
async function handleTabCreated(tab: chrome.tabs.Tab) {
  // Skip chrome:// and extension pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  const state = await getRecordingState();
  if (!state.isRecording) {
    return;
  }

  if (!tab.id) return;

  // Wait for tab to be fully loaded before initializing
  const checkTabReady = async (retries = 0) => {
    try {
      const updatedTab = await chrome.tabs.get(tab.id!);
      if (updatedTab.status === 'complete') {
        await initializeRecordingOnTab(tab.id!, state.config!);
      } else if (retries < 20) {
        // Wait up to 2 seconds for tab to load
        setTimeout(() => checkTabReady(retries + 1), 100);
      }
    } catch (error) {
      console.warn('[Recording] Could not initialize on new tab:', error);
    }
  };

  // Start checking after a short delay
  setTimeout(() => checkTabReady(), 200);
}

// Handle tab updates (page navigation)
async function handleTabUpdate(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab
) {
  // Only handle when page is fully loaded
  if (changeInfo.status !== 'complete') return;
  
  // Skip chrome:// and extension pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    return;
  }

  const state = await getRecordingState();
  if (!state.isRecording) {
    return;
  }

  await initializeRecordingOnTab(tabId, state.config!);
}

// Initialize recording on a specific tab (shared logic)
async function initializeRecordingOnTab(tabId: number, config: CaptureConfig) {
  let retries = 0;
  const maxRetries = 10;
  
  const tryInitialize = async () => {
    try {
      // Try to send message to content script
      await chrome.tabs.sendMessage(tabId, {
        type: 'START_RECORDING',
        payload: { config },
      });
      const tab = await chrome.tabs.get(tabId);
      console.log('[Recording] Initialized on tab:', tab.url);
    } catch (error) {
      // Content script might not be loaded yet, retry
      if (retries < maxRetries) {
        retries++;
        // Exponential backoff: 100ms, 200ms, 400ms, etc. up to 1s
        const delay = Math.min(100 * Math.pow(2, retries - 1), 1000);
        setTimeout(tryInitialize, delay);
      } else {
        // Last resort: try to inject manually (though it should be auto-loaded)
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['recording.js'],
          });
          // Wait longer for script to initialize
          await new Promise((resolve) => setTimeout(resolve, 500));
          await chrome.tabs.sendMessage(tabId, {
            type: 'START_RECORDING',
            payload: { config },
          });
          const tab = await chrome.tabs.get(tabId);
          console.log('[Recording] Manually injected and initialized on:', tab.url);
        } catch (injectError) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          console.warn('[Recording] Could not initialize on tab:', tab?.url || tabId, injectError);
        }
      }
    }
  };
  
  // Start initialization attempt after a short delay to let content script load
  setTimeout(tryInitialize, 300);
}

// Capture initial snapshot when recording starts
async function captureInitialSnapshot(tabId: number, traceId: string): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    // Get page metadata (inject content script if needed)
    const response = await injectAndMessage<{ payload: { url: string; title: string; viewport: { width: number; height: number } } }>(
      tabId,
      'content.js',
      { type: 'GET_PAGE_METADATA' }
    );
    const metadata = response.payload;

    // Capture the page
    const { html, title } = await capturePageAsMhtml(tabId, metadata.url);
    const snapshot: Snapshot = {
      id: generateId(),
      url: metadata.url,
      title: title,
      html: html,
      viewport: metadata.viewport,
      annotations: { text: [], region: [] },
      questions: [],
      status: 'pending',
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['record-mode', 'initial'],
    };
    await saveSnapshot(snapshot);

    // Update trace with initial snapshot ID
    const trace = await getTrace(traceId);
    if (trace) {
      trace.initialSnapshotId = snapshot.id;
      trace.updatedAt = new Date().toISOString();
      await saveTrace(trace);
      console.log('[Recording] Captured initial snapshot:', snapshot.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to capture initial snapshot:', error);
  }
}

// Stop recording
async function stopRecording(): Promise<{ traceId: string }> {
  const state = await getRecordingState();
  if (!state.isRecording || !state.currentTraceId) {
    throw new Error('No recording in progress');
  }

  const traceId = state.currentTraceId;
  const trace = await getTrace(traceId);
  if (trace) {
    trace.stoppedAt = new Date().toISOString();
    trace.updatedAt = new Date().toISOString();
    await saveTrace(trace);
  }

  // Capture final snapshot from active tab before stopping (excluding extension pages)
  try {
    console.log('[Recording] Looking for active tab for final snapshot...');
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    console.log('[Recording] Found tabs in lastFocusedWindow:', tabs.map(t => t.url?.substring(0, 50)));
    
    let activeTab = tabs.find(t => 
      t.url && 
      !t.url.startsWith('chrome://') && 
      !t.url.startsWith('chrome-extension://')
    );
    
    // If no capturable tab in focused window, try all windows
    if (!activeTab) {
      console.log('[Recording] No capturable tab in focused window, trying all windows...');
      const allTabs = await chrome.tabs.query({ active: true });
      console.log('[Recording] Found all active tabs:', allTabs.map(t => t.url?.substring(0, 50)));
      activeTab = allTabs.find(t => 
        t.url && 
        !t.url.startsWith('chrome://') && 
        !t.url.startsWith('chrome-extension://')
      );
    }
    
    if (activeTab?.id && activeTab?.url) {
      console.log('[Recording] Capturing final snapshot from:', activeTab.url);
      await captureFinalSnapshot(activeTab.id, traceId);
      console.log('[Recording] Final snapshot captured successfully');
    } else {
      console.log('[Recording] No capturable tab found for final snapshot');
    }
  } catch (error) {
    console.warn('[Recording] Could not capture final snapshot:', error);
  }

  await setRecordingState({
    isRecording: false,
    currentTraceId: null,
    config: null,
  });

  // Notify all tabs to stop recording
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_RECORDING' });
      } catch {
        // Tab might not have content script loaded, ignore
      }
    }
  }

  // Remove tab listeners
  chrome.tabs.onUpdated.removeListener(handleTabUpdate);
  chrome.tabs.onCreated.removeListener(handleTabCreated);

  return { traceId };
}

// Capture final snapshot when recording stops
async function captureFinalSnapshot(tabId: number, traceId: string): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      return;
    }

    // Get page metadata (inject content script if needed)
    const response = await injectAndMessage<{ payload: { url: string; title: string; viewport: { width: number; height: number } } }>(
      tabId,
      'content.js',
      { type: 'GET_PAGE_METADATA' }
    );
    const metadata = response.payload;

    // Capture the page
    const { html, title } = await capturePageAsMhtml(tabId, metadata.url);
    const snapshot: Snapshot = {
      id: generateId(),
      url: metadata.url,
      title: title,
      html: html,
      viewport: metadata.viewport,
      annotations: { text: [], region: [] },
      questions: [],
      status: 'pending',
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: ['record-mode', 'final'],
    };
    await saveSnapshot(snapshot);

    // Update trace with final snapshot ID
    const trace = await getTrace(traceId);
    if (trace) {
      trace.finalSnapshotId = snapshot.id;
      trace.updatedAt = new Date().toISOString();
      await saveTrace(trace);
      console.log('[Recording] Captured final snapshot:', snapshot.id);
    }
  } catch (error) {
    console.error('[Recording] Failed to capture final snapshot:', error);
  }
}

// Record an interaction (capture pre and post snapshots)
async function recordInteraction(
  interaction: Omit<InteractionRecord, 'preSnapshotId' | 'postSnapshotId'>,
  tabId: number
): Promise<void> {
  const state = await getRecordingState();
  if (!state.isRecording || !state.currentTraceId) {
    console.warn('[Recording] Not active, ignoring interaction:', interaction.id);
    return;
  }

  const trace = await getTrace(state.currentTraceId);
  if (!trace) {
    console.error('[Recording] Trace not found:', state.currentTraceId);
    return;
  }

  // Validate interaction data
  if (!interaction || !interaction.id || !interaction.action) {
    console.error('[Recording] Invalid interaction data:', interaction);
    return;
  }

  try {
    // Verify tab still exists and is accessible
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
      if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
        console.warn('[Recording] Cannot capture from system page:', tab.url);
        return;
      }
    } catch (error) {
      console.error('[Recording] Tab no longer accessible:', tabId, error);
      return;
    }

    // Get page metadata (inject content script if needed)
    let metadata: { url: string; title: string; viewport: { width: number; height: number } };
    try {
      const response = await injectAndMessage<{ payload: { url: string; title: string; viewport: { width: number; height: number } } }>(
        tabId,
        'content.js',
        { type: 'GET_PAGE_METADATA' }
      );
      if (!response || !response.payload) {
        throw new Error('No metadata response');
      }
      metadata = response.payload;
    } catch (error) {
      console.error('[Recording] Failed to get page metadata:', error);
      return;
    }

    console.log(`[Recording] Capturing interaction ${interaction.id} (${interaction.action.type}) on tab ${tabId}`, {
      url: tab.url,
      windowId: tab.windowId,
      active: tab.active,
      status: tab.status
    });

    // Capture pre-action snapshot
    let preSnapshot: Snapshot;
    try {
      const { html: preHtml, title: preTitle } = await capturePageAsMhtml(tabId, metadata.url);
      preSnapshot = {
        id: generateId(),
        url: metadata.url,
        title: preTitle,
        html: preHtml,
        viewport: metadata.viewport,
        annotations: { text: [], region: [] },
        questions: [],
        status: 'pending',
        capturedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: ['record-mode', 'pre-action'],
      };
      await saveSnapshot(preSnapshot);
      console.log(`[Recording] Pre-action snapshot captured: ${preSnapshot.id}`);
    } catch (error) {
      console.error('[Recording] Failed to capture pre-action snapshot:', error);
      return;
    }

    // Note: We previously waited 500ms here "for DOM to settle" but this is unnecessary
    // since the MHTML capture happens atomically. The pre-snapshot is taken BEFORE the 
    // interaction, and post-snapshot is requested AFTER (the content script already waited
    // for the interaction to complete before sending RECORD_INTERACTION).

    // Capture post-action snapshot
    let postSnapshot: Snapshot;
    try {
      const { html: postHtml, title: postTitle } = await capturePageAsMhtml(tabId, metadata.url);
      postSnapshot = {
        id: generateId(),
        url: metadata.url,
        title: postTitle,
        html: postHtml,
        viewport: metadata.viewport,
        annotations: { text: [], region: [] },
        questions: [],
        status: 'pending',
        capturedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: ['record-mode', 'post-action'],
      };
      await saveSnapshot(postSnapshot);
      console.log(`[Recording] Post-action snapshot captured: ${postSnapshot.id}`);
    } catch (error) {
      console.error('[Recording] Failed to capture post-action snapshot:', error);
      // Still save the interaction with just pre-action snapshot
      postSnapshot = preSnapshot; // Use pre-action as fallback
    }

    // Create complete interaction record
    const completeInteraction: InteractionRecord = {
      ...interaction,
      preSnapshotId: preSnapshot.id,
      postSnapshotId: postSnapshot.id,
    };

    // Add to trace
    trace.interactions.push(completeInteraction);
    trace.updatedAt = new Date().toISOString();
    await saveTrace(trace);

    console.log(
      `[Recording] Successfully recorded interaction ${completeInteraction.id} (${completeInteraction.action.type}), ` +
      `snapshots: ${preSnapshot.id} → ${postSnapshot.id}`
    );
  } catch (error) {
    console.error('[Recording] Failed to record interaction:', error, interaction);
  }
}

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Skip messages without a type (e.g., from other extensions)
  if (!message?.type) {
    return false;
  }

  // Handle offscreen document ready signal
  if (message.type === 'OFFSCREEN_READY') {
    handleOffscreenReady();
    return false;
  }

  // Skip messages from offscreen document (responses)
  if (message.type === 'CONVERT_MHTML_COMPLETE' || message.type === 'CONVERT_MHTML_ERROR') {
    return false;
  }

  const handleMessage = async (): Promise<unknown> => {
    switch (message.type) {
      case 'GET_ALL_SNAPSHOTS':
        return getAllSnapshotSummaries(); // Use lightweight summaries to avoid 64MB limit

      case 'GET_SNAPSHOT':
        return getSnapshot(message.payload.id);

      case 'SAVE_SNAPSHOT':
        await saveSnapshot(message.payload.snapshot);
        return { success: true };

      case 'UPDATE_SNAPSHOT':
        return updateSnapshot(message.payload.id, message.payload.updates);

      case 'DELETE_SNAPSHOT':
        await deleteSnapshot(message.payload.id);
        return { success: true };

      case 'EXPORT_DATA':
        return exportAllData();

      case 'IMPORT_DATA':
        return importData(message.payload.data);

      case 'OPEN_VIEWER': {
        const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${message.payload.snapshotId}`);
        await chrome.tabs.create({ url: viewerUrl });
        return { success: true };
      }

      case 'CAPTURE_PAGE': {
        // Query for the active tab, excluding extension pages
        // The popup is technically in currentWindow, so we need to find the actual webpage tab
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        
        // Filter out extension and browser internal pages
        const capturableTabs = tabs.filter(t => 
          t.url && 
          !t.url.startsWith('chrome://') &&
          !t.url.startsWith('chrome-extension://') &&
          !t.url.startsWith('edge://') &&
          !t.url.startsWith('about:') &&
          !t.url.startsWith('devtools://')
        );
        
        // If no capturable tab in focused window, try all windows
        let tab = capturableTabs[0];
        if (!tab) {
          const allTabs = await chrome.tabs.query({ active: true });
          const allCapturableTabs = allTabs.filter(t => 
            t.url && 
            !t.url.startsWith('chrome://') &&
            !t.url.startsWith('chrome-extension://') &&
            !t.url.startsWith('edge://') &&
            !t.url.startsWith('about:') &&
            !t.url.startsWith('devtools://')
          );
          tab = allCapturableTabs[0];
        }
        
        if (!tab?.id || !tab?.url) {
          throw new Error('No capturable tab found - open a webpage first');
        }
        
        console.log('refine.page: CAPTURE_PAGE - selected tab:', { 
          id: tab.id, 
          url: tab.url, 
          windowId: tab.windowId,
          active: tab.active,
          status: tab.status 
        });
        
        const url = tab.url;

        try {
          console.log('refine.page: CAPTURE_PAGE step 1 - getting metadata for tab', tab.id);
          
          // Get page metadata (inject content script if needed)
          let metadata: { url: string; title: string; viewport: { width: number; height: number } };
          try {
            const metadataResponse = await injectAndMessage<{ payload: { url: string; title: string; viewport: { width: number; height: number } } }>(
              tab.id,
              'content.js',
              { type: 'GET_PAGE_METADATA' }
            );
            metadata = metadataResponse.payload;
            console.log('refine.page: CAPTURE_PAGE step 1 complete - got metadata');
          } catch (metaError) {
            throw new Error(`Step 1 (metadata) failed: ${(metaError as Error).message}`);
          }

          console.log('refine.page: CAPTURE_PAGE step 2 - capturing MHTML');
          
          // Ensure tab is active and focused (workaround for Chromium pageCapture issues)
          try {
            await chrome.tabs.update(tab.id, { active: true });
            const tabWindow = await chrome.windows.get(tab.windowId);
            if (!tabWindow.focused) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } catch {
            // Non-fatal - tab might already be active
          }
          
          // Capture the page as MHTML and convert to HTML (via offscreen document)
          let html: string;
          try {
            const result = await capturePageAsMhtml(tab.id, metadata.url);
            html = result.html;
            console.log('refine.page: CAPTURE_PAGE step 2 complete - MHTML captured');
          } catch (captureError) {
            throw new Error(`Step 2 (MHTML capture) failed: ${(captureError as Error).message}`);
          }

          // Create the snapshot
          const snapshot: Snapshot = {
            id: generateId(),
            url: metadata.url,
            title: metadata.title,
            html: html,
            viewport: metadata.viewport,
            annotations: { text: [], region: [] },
            questions: [],
            status: 'pending',
            capturedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: [],
          };

          // Save the snapshot
          await saveSnapshot(snapshot);

          console.log(
            `refine.page: Snapshot saved, id: ${snapshot.id}, size: ${(html.length / 1024).toFixed(1)}KB`
          );

          return { type: 'CAPTURE_COMPLETE', payload: { snapshotId: snapshot.id } };
        } catch (error) {
          const err = error as Error;
          console.error('refine.page: Capture error:', err);
          return {
            type: 'CAPTURE_ERROR',
            payload: { 
              error: err.message || 'Unknown error',
              stack: err.stack,
              name: err.name 
            },
          };
        }
      }

      case 'START_RECORDING': {
        const config = message.payload?.config;
        const result = await startRecording(config);
        return result;
      }

      case 'STOP_RECORDING': {
        const result = await stopRecording();
        return result;
      }

      case 'GET_RECORDING_STATE': {
        const state = await getRecordingState();
        return state;
      }

      case 'RECORD_INTERACTION': {
        const { interaction } = message.payload;
        const tabId = sender.tab?.id;
        if (!tabId) {
          throw new Error('No tab ID available');
        }
        // Don't await - let it run in background to avoid blocking
        // If it fails, it will log errors but won't block the content script
        recordInteraction(interaction, tabId).catch((error) => {
          console.error('[Recording] Error recording interaction (non-blocking):', error);
        });
        return { success: true };
      }

      case 'PAGE_NAVIGATING': {
        // Page is navigating away - recording will be re-initialized on new page via tab update listener
        return { success: true };
      }

      case 'GET_TRACES': {
        return getAllTraces();
      }

      case 'GET_TRACE': {
        return getTrace(message.payload.id);
      }

      case 'DELETE_TRACE': {
        await deleteTrace(message.payload.id);
        return { success: true };
      }

      case 'EXPORT_TRACE': {
        const trace = await getTrace(message.payload.id);
        if (!trace) {
          throw new Error('Trace not found');
        }
        // Export trace as JSON (snapshots are already stored separately)
        return trace;
      }

      default:
        // Unknown message type - don't handle it
        return undefined;
    }
  };

  // Check if this is a message type we handle
  const knownTypes = [
    'GET_ALL_SNAPSHOTS',
    'GET_SNAPSHOT',
    'SAVE_SNAPSHOT',
    'UPDATE_SNAPSHOT',
    'DELETE_SNAPSHOT',
    'EXPORT_DATA',
    'IMPORT_DATA',
    'OPEN_VIEWER',
    'CAPTURE_PAGE',
    'START_RECORDING',
    'STOP_RECORDING',
    'GET_RECORDING_STATE',
    'RECORD_INTERACTION',
    'GET_TRACES',
    'GET_TRACE',
    'DELETE_TRACE',
    'EXPORT_TRACE',
  ];
  if (!knownTypes.includes(message.type)) {
    return false; // Let other listeners handle it
  }

  handleMessage()
    .then(sendResponse)
    .catch((error) => {
      console.error('Background script error:', error);
      sendResponse({ error: error.message });
    });

  return true; // Indicates async response
});

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('refine.page extension installed');
    // Initialize storage
    chrome.storage.local.set({ snapshotIndex: [] });
  }
});

console.log('refine.page: Background service worker started');
