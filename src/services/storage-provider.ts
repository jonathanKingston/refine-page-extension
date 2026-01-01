/**
 * Storage Provider Abstraction
 * Allows the eval service to work with different storage backends:
 * - Chrome extension storage (chrome.storage.local)
 * - HTTP/Web storage (fetching from URLs)
 * - In-memory storage (for testing)
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';

/**
 * Lightweight snapshot summary (without HTML) for listing
 * Avoids loading large HTML content when just displaying a list
 */
export interface SnapshotSummary {
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

/**
 * Storage provider interface
 * Implementations handle the actual storage mechanism
 */
export interface StorageProvider {
  /**
   * Get a single snapshot by ID
   */
  getSnapshot(id: string): Promise<Snapshot | null>;

  /**
   * Get all snapshot summaries (lightweight, no HTML)
   */
  getAllSnapshotSummaries(): Promise<SnapshotSummary[]>;

  /**
   * Get all snapshots (full data including HTML)
   */
  getAllSnapshots(): Promise<Snapshot[]>;

  /**
   * Save a snapshot
   */
  saveSnapshot(snapshot: Snapshot): Promise<void>;

  /**
   * Update a snapshot
   */
  updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | null>;

  /**
   * Delete a snapshot
   */
  deleteSnapshot(id: string): Promise<void>;

  /**
   * Export all data
   */
  exportAllData(): Promise<ExportData>;

  /**
   * Import data
   */
  importData(data: ExportData): Promise<{ imported: number; skipped: number }>;

  /**
   * Get the URL for an asset (like iframe.html)
   * Returns null if not applicable for this provider
   */
  getAssetUrl(assetPath: string): string | null;

  /**
   * Check if this provider supports write operations
   */
  readonly isReadOnly: boolean;

  /**
   * Provider type identifier
   */
  readonly type: 'chrome' | 'http' | 'memory';
}

/**
 * Configuration for HTTP storage provider
 */
export interface HttpStorageConfig {
  /**
   * Base URL for fetching snapshots
   * e.g., "https://example.com/api/snapshots"
   */
  baseUrl: string;

  /**
   * URL to fetch the snapshot index/list
   * e.g., "https://example.com/api/snapshots/index.json"
   */
  indexUrl?: string;

  /**
   * URL pattern for fetching individual snapshots
   * Use {id} as placeholder for snapshot ID
   * e.g., "https://example.com/api/snapshots/{id}.json"
   */
  snapshotUrlPattern?: string;

  /**
   * URL for static assets (iframe.html, etc.)
   * If not provided, assets are expected to be served from the same origin
   */
  assetsBaseUrl?: string;

  /**
   * Custom headers to include in fetch requests
   */
  headers?: Record<string, string>;

  /**
   * Whether to enable CORS mode
   */
  cors?: boolean;

  /**
   * Callback for write operations (if supported by the backend)
   */
  onSave?: (snapshot: Snapshot) => Promise<void>;
  onUpdate?: (id: string, updates: Partial<Snapshot>) => Promise<Snapshot | null>;
  onDelete?: (id: string) => Promise<void>;
}

/**
 * Storage service configuration
 */
export interface StorageServiceConfig {
  provider: 'chrome' | 'http' | 'memory';
  httpConfig?: HttpStorageConfig;
}
