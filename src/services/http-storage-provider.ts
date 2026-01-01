/**
 * HTTP Storage Provider
 * Fetches snapshots and data from remote URLs
 * Used when running the viewer as a standalone web application
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';
import type { StorageProvider, SnapshotSummary, HttpStorageConfig } from './storage-provider';

/**
 * Index file structure for listing available snapshots
 */
interface SnapshotIndex {
  version?: string;
  snapshots: Array<SnapshotSummary | { id: string; url?: string }>;
}

export class HttpStorageProvider implements StorageProvider {
  readonly type = 'http' as const;

  private config: HttpStorageConfig;
  private cache: Map<string, Snapshot> = new Map();
  private indexCache: SnapshotSummary[] | null = null;

  constructor(config: HttpStorageConfig) {
    this.config = config;
  }

  get isReadOnly(): boolean {
    // Read-only unless write callbacks are provided
    return !(this.config.onSave && this.config.onUpdate && this.config.onDelete);
  }

  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };
  }

  private getFetchOptions(): RequestInit {
    return {
      headers: this.getHeaders(),
      mode: this.config.cors !== false ? 'cors' : 'same-origin',
    };
  }

  private getSnapshotUrl(id: string): string {
    if (this.config.snapshotUrlPattern) {
      return this.config.snapshotUrlPattern.replace('{id}', id);
    }
    // Default: baseUrl/snapshots/{id}.json
    return `${this.config.baseUrl}/snapshots/${id}.json`;
  }

  private getIndexUrl(): string {
    if (this.config.indexUrl) {
      return this.config.indexUrl;
    }
    // Default: baseUrl/index.json
    return `${this.config.baseUrl}/index.json`;
  }

  async getSnapshot(id: string): Promise<Snapshot | null> {
    // Check cache first
    if (this.cache.has(id)) {
      return this.cache.get(id)!;
    }

    try {
      const url = this.getSnapshotUrl(id);
      const response = await fetch(url, this.getFetchOptions());

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const snapshot: Snapshot = await response.json();

      // Cache the snapshot
      this.cache.set(id, snapshot);

      return snapshot;
    } catch (error) {
      console.error(`[HttpStorageProvider] Failed to fetch snapshot ${id}:`, error);
      return null;
    }
  }

  async getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
    // Return cached index if available
    if (this.indexCache) {
      return this.indexCache;
    }

    try {
      const url = this.getIndexUrl();
      const response = await fetch(url, this.getFetchOptions());

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: SnapshotIndex = await response.json();

      // Convert to SnapshotSummary format
      const summaries: SnapshotSummary[] = data.snapshots.map((item) => {
        // If already a full summary, use it
        if ('title' in item) {
          return item as SnapshotSummary;
        }

        // Minimal format - create a partial summary
        return {
          id: item.id,
          url: item.url || '',
          title: item.id,
          status: 'pending' as const,
          capturedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          annotationCount: { text: 0, region: 0 },
          questionCount: 0,
        };
      });

      // Sort by capturedAt (newest first)
      summaries.sort((a, b) =>
        new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
      );

      // Cache the index
      this.indexCache = summaries;

      return summaries;
    } catch (error) {
      console.error('[HttpStorageProvider] Failed to fetch snapshot index:', error);
      return [];
    }
  }

  async getAllSnapshots(): Promise<Snapshot[]> {
    const summaries = await this.getAllSnapshotSummaries();
    const snapshots: Snapshot[] = [];

    // Fetch all snapshots in parallel
    const results = await Promise.allSettled(
      summaries.map((s) => this.getSnapshot(s.id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        snapshots.push(result.value);
      }
    }

    return snapshots.sort((a, b) =>
      new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
    );
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    if (this.config.onSave) {
      await this.config.onSave(snapshot);
      // Update cache
      this.cache.set(snapshot.id, snapshot);
      // Invalidate index cache
      this.indexCache = null;
    } else {
      throw new Error('Save operation not supported: provider is read-only');
    }
  }

  async updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | null> {
    if (this.config.onUpdate) {
      const updated = await this.config.onUpdate(id, updates);
      if (updated) {
        // Update cache
        this.cache.set(id, updated);
      }
      return updated;
    } else {
      throw new Error('Update operation not supported: provider is read-only');
    }
  }

  async deleteSnapshot(id: string): Promise<void> {
    if (this.config.onDelete) {
      await this.config.onDelete(id);
      // Remove from cache
      this.cache.delete(id);
      // Invalidate index cache
      this.indexCache = null;
    } else {
      throw new Error('Delete operation not supported: provider is read-only');
    }
  }

  async exportAllData(): Promise<ExportData> {
    const snapshots = await this.getAllSnapshots();

    const exportedSnapshots: ExportedSnapshot[] = snapshots.map((snapshot) => ({
      ...snapshot,
      viewerUrl: `${this.config.baseUrl}/viewer.html?id=${snapshot.id}`,
    }));

    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      snapshots: exportedSnapshots,
    };
  }

  async importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
    if (!this.config.onSave) {
      throw new Error('Import operation not supported: provider is read-only');
    }

    let imported = 0;
    let skipped = 0;

    for (const snapshot of data.snapshots) {
      const existing = await this.getSnapshot(snapshot.id);
      if (existing) {
        skipped++;
      } else {
        await this.saveSnapshot(snapshot);
        imported++;
      }
    }

    return { imported, skipped };
  }

  getAssetUrl(assetPath: string): string | null {
    if (this.config.assetsBaseUrl) {
      // Use configured assets base URL
      return `${this.config.assetsBaseUrl}/${assetPath}`;
    }
    // Assets served from same origin - just return the path
    return `/${assetPath}`;
  }

  /**
   * Clear the cache (useful for refreshing data)
   */
  clearCache(): void {
    this.cache.clear();
    this.indexCache = null;
  }

  /**
   * Preload a snapshot into the cache
   */
  preloadSnapshot(snapshot: Snapshot): void {
    this.cache.set(snapshot.id, snapshot);
  }

  /**
   * Preload the index into the cache
   */
  preloadIndex(summaries: SnapshotSummary[]): void {
    this.indexCache = summaries;
  }
}

/**
 * Create an HTTP storage provider instance
 */
export function createHttpStorageProvider(config: HttpStorageConfig): HttpStorageProvider {
  return new HttpStorageProvider(config);
}
