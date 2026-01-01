/**
 * Storage Service
 * Unified interface for storage operations with automatic provider selection
 */

import type { Snapshot, ExportData } from '@/types';
import type { StorageProvider, SnapshotSummary, StorageServiceConfig, HttpStorageConfig } from './storage-provider';
import { ChromeStorageProvider, createChromeStorageProvider } from './chrome-storage-provider';
import { HttpStorageProvider, createHttpStorageProvider } from './http-storage-provider';

// In-memory storage provider for testing
class MemoryStorageProvider implements StorageProvider {
  readonly type = 'memory' as const;
  readonly isReadOnly = false;

  private snapshots: Map<string, Snapshot> = new Map();

  async getSnapshot(id: string): Promise<Snapshot | null> {
    return this.snapshots.get(id) || null;
  }

  async getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
    return Array.from(this.snapshots.values()).map((s) => ({
      id: s.id,
      url: s.url,
      title: s.title,
      status: s.status,
      capturedAt: s.capturedAt,
      updatedAt: s.updatedAt,
      tags: s.tags,
      annotationCount: {
        text: s.annotations.text.length,
        region: s.annotations.region.length,
      },
      questionCount: s.questions.length,
    }));
  }

  async getAllSnapshots(): Promise<Snapshot[]> {
    return Array.from(this.snapshots.values());
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshots.set(snapshot.id, snapshot);
  }

  async updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | null> {
    const existing = this.snapshots.get(id);
    if (!existing) return null;

    const updated: Snapshot = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.snapshots.set(id, updated);
    return updated;
  }

  async deleteSnapshot(id: string): Promise<void> {
    this.snapshots.delete(id);
  }

  async exportAllData(): Promise<ExportData> {
    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      snapshots: Array.from(this.snapshots.values()),
    };
  }

  async importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;

    for (const snapshot of data.snapshots) {
      if (this.snapshots.has(snapshot.id)) {
        skipped++;
      } else {
        this.snapshots.set(snapshot.id, snapshot);
        imported++;
      }
    }

    return { imported, skipped };
  }

  getAssetUrl(assetPath: string): string | null {
    return `/${assetPath}`;
  }
}

/**
 * Detect the runtime environment and return appropriate provider type
 */
function detectEnvironment(): 'chrome' | 'http' {
  // Check if Chrome extension APIs are available
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    return 'chrome';
  }

  // Default to HTTP for web environments
  return 'http';
}

/**
 * Parse configuration from URL parameters
 */
function parseUrlConfig(): Partial<HttpStorageConfig> | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);

  // Check for data URL parameter (direct snapshot loading)
  const dataUrl = params.get('dataUrl') || params.get('data-url');
  if (dataUrl) {
    return {
      baseUrl: new URL(dataUrl, window.location.href).href.replace(/\/[^/]*$/, ''),
      snapshotUrlPattern: dataUrl.includes('{id}') ? dataUrl : undefined,
    };
  }

  // Check for base URL parameter
  const baseUrl = params.get('baseUrl') || params.get('base-url');
  if (baseUrl) {
    return { baseUrl };
  }

  return null;
}

/**
 * Parse configuration from global window config
 */
function parseGlobalConfig(): Partial<HttpStorageConfig> | null {
  if (typeof window === 'undefined') return null;

  const globalConfig = (window as unknown as { REFINE_PAGE_CONFIG?: Partial<HttpStorageConfig> }).REFINE_PAGE_CONFIG;
  if (globalConfig) {
    return globalConfig;
  }

  return null;
}

/**
 * Storage service singleton
 */
class StorageService {
  private static instance: StorageService | null = null;
  private provider: StorageProvider | null = null;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  /**
   * Initialize the storage service with a specific configuration
   */
  async initialize(config?: StorageServiceConfig): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize(config);
    return this.initPromise;
  }

  private async _initialize(config?: StorageServiceConfig): Promise<void> {
    if (config) {
      // Use provided configuration
      this.provider = this.createProvider(config);
    } else {
      // Auto-detect environment
      const env = detectEnvironment();

      if (env === 'chrome') {
        this.provider = createChromeStorageProvider();
      } else {
        // Try to get config from URL or global
        const urlConfig = parseUrlConfig();
        const globalConfig = parseGlobalConfig();
        const httpConfig: HttpStorageConfig = {
          baseUrl: window.location.origin,
          ...globalConfig,
          ...urlConfig,
        };
        this.provider = createHttpStorageProvider(httpConfig);
      }
    }
  }

  private createProvider(config: StorageServiceConfig): StorageProvider {
    switch (config.provider) {
      case 'chrome':
        return createChromeStorageProvider();
      case 'http':
        if (!config.httpConfig) {
          throw new Error('HTTP config required for http provider');
        }
        return createHttpStorageProvider(config.httpConfig);
      case 'memory':
        return new MemoryStorageProvider();
      default:
        throw new Error(`Unknown provider type: ${config.provider}`);
    }
  }

  /**
   * Get the current storage provider
   */
  getProvider(): StorageProvider {
    if (!this.provider) {
      throw new Error('Storage service not initialized. Call initialize() first.');
    }
    return this.provider;
  }

  /**
   * Check if the service has been initialized
   */
  isInitialized(): boolean {
    return this.provider !== null;
  }

  /**
   * Reset the service (for testing)
   */
  reset(): void {
    this.provider = null;
    this.initPromise = null;
  }
}

// Export singleton instance
export const storageService = StorageService.getInstance();

// Export convenience functions that use the singleton
export async function initializeStorage(config?: StorageServiceConfig): Promise<void> {
  return storageService.initialize(config);
}

export function getStorageProvider(): StorageProvider {
  return storageService.getProvider();
}

// Re-export types and providers
export { ChromeStorageProvider, HttpStorageProvider, MemoryStorageProvider };
export type { StorageProvider, SnapshotSummary, StorageServiceConfig, HttpStorageConfig };
