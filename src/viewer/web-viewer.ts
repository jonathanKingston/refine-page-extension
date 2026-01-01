/**
 * Web Viewer Entry Point
 *
 * This module provides a simple API for loading the refine.page viewer
 * in a web server context, fetching data from third-party URLs.
 *
 * Usage in HTML:
 * <script>
 *   window.REFINE_PAGE_CONFIG = {
 *     baseUrl: 'https://your-api.com/snapshots',
 *     // Optional: custom patterns
 *     snapshotUrlPattern: 'https://your-api.com/snapshots/{id}.json',
 *     indexUrl: 'https://your-api.com/snapshots/index.json',
 *   };
 * </script>
 * <script src="web-viewer.js"></script>
 *
 * Or via URL parameters:
 * viewer.html?baseUrl=https://your-api.com/snapshots&id=snapshot_123
 */

import {
  initializeStorage,
  getStorageProvider,
  createHttpStorageProvider,
  type HttpStorageConfig,
} from '@/services';
import type { Snapshot } from '@/types';

/**
 * Configuration for the web viewer
 */
export interface WebViewerConfig extends HttpStorageConfig {
  /**
   * Snapshot ID to load initially (can also be passed via URL ?id=)
   */
  snapshotId?: string;

  /**
   * Callback when a snapshot is loaded
   */
  onSnapshotLoaded?: (snapshot: Snapshot) => void;

  /**
   * Callback when the viewer is ready
   */
  onReady?: () => void;

  /**
   * Callback for errors
   */
  onError?: (error: Error) => void;
}

/**
 * Initialize the web viewer with a configuration
 */
export async function initWebViewer(config: WebViewerConfig): Promise<void> {
  // Set the global config for the viewer to pick up
  (window as unknown as { REFINE_PAGE_CONFIG: Partial<HttpStorageConfig> }).REFINE_PAGE_CONFIG = {
    baseUrl: config.baseUrl,
    indexUrl: config.indexUrl,
    snapshotUrlPattern: config.snapshotUrlPattern,
    assetsBaseUrl: config.assetsBaseUrl,
    headers: config.headers,
    cors: config.cors,
    onSave: config.onSave,
    onUpdate: config.onUpdate,
    onDelete: config.onDelete,
  };

  // Wait for the viewer to initialize
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve());
    });
  }

  // The viewer.ts will pick up the config and initialize automatically
  config.onReady?.();
}

/**
 * Load a snapshot directly into the viewer
 * (Alternative to using URL parameters)
 */
export async function loadSnapshot(snapshot: Snapshot): Promise<void> {
  // Get the provider and preload the snapshot
  try {
    const provider = getStorageProvider();
    if ('preloadSnapshot' in provider && typeof provider.preloadSnapshot === 'function') {
      (provider as { preloadSnapshot: (s: Snapshot) => void }).preloadSnapshot(snapshot);
    }

    // Trigger navigation to the snapshot
    const url = new URL(window.location.href);
    url.searchParams.set('id', snapshot.id);
    window.history.pushState({}, '', url.toString());

    // Dispatch a custom event for the viewer to pick up
    window.dispatchEvent(new CustomEvent('refine-page:load-snapshot', {
      detail: { snapshotId: snapshot.id }
    }));
  } catch (error) {
    console.error('[WebViewer] Failed to load snapshot:', error);
    throw error;
  }
}

/**
 * Load a snapshot from a URL
 */
export async function loadSnapshotFromUrl(url: string): Promise<Snapshot> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch snapshot: ${response.status} ${response.statusText}`);
  }

  const snapshot: Snapshot = await response.json();
  await loadSnapshot(snapshot);
  return snapshot;
}

/**
 * Get the current viewer configuration
 */
export function getViewerConfig(): Partial<HttpStorageConfig> | null {
  return (window as unknown as { REFINE_PAGE_CONFIG?: Partial<HttpStorageConfig> }).REFINE_PAGE_CONFIG || null;
}

/**
 * Check if running in web mode (vs Chrome extension mode)
 */
export function isWebMode(): boolean {
  return typeof chrome === 'undefined' || !chrome.runtime?.id;
}

// Export for use as a module
export { initializeStorage, getStorageProvider, createHttpStorageProvider };
export type { Snapshot, HttpStorageConfig };
