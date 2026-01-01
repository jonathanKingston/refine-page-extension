/**
 * Chrome Extension Storage Provider
 * Uses chrome.storage.local for persistence
 * This is the default provider when running as a Chrome extension
 */

import type { Snapshot, ExportData, ExportedSnapshot } from '@/types';
import type { StorageProvider, SnapshotSummary } from './storage-provider';

export class ChromeStorageProvider implements StorageProvider {
  readonly type = 'chrome' as const;
  readonly isReadOnly = false;

  private async getSnapshotIndex(): Promise<string[]> {
    const result = await chrome.storage.local.get('snapshotIndex');
    return result.snapshotIndex || [];
  }

  async getSnapshot(id: string): Promise<Snapshot | null> {
    const key = `snapshot_${id}`;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  async getAllSnapshotSummaries(): Promise<SnapshotSummary[]> {
    const index = await this.getSnapshotIndex();
    const summaries: SnapshotSummary[] = [];

    for (const id of index) {
      const snapshot = await this.getSnapshot(id);
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

    return summaries.sort((a, b) =>
      new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
    );
  }

  async getAllSnapshots(): Promise<Snapshot[]> {
    const index = await this.getSnapshotIndex();
    const keys = index.map((id) => `snapshot_${id}`);
    if (keys.length === 0) return [];

    const result = await chrome.storage.local.get(keys);
    const snapshots = keys.map((key) => result[key]).filter(Boolean) as Snapshot[];

    return snapshots.sort((a, b) =>
      new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
    );
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const key = `snapshot_${snapshot.id}`;
    await chrome.storage.local.set({ [key]: snapshot });

    // Update the index
    const index = await this.getSnapshotIndex();
    if (!index.includes(snapshot.id)) {
      index.push(snapshot.id);
      await chrome.storage.local.set({ snapshotIndex: index });
    }
  }

  async updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | null> {
    const existing = await this.getSnapshot(id);
    if (!existing) return null;

    const updated: Snapshot = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await this.saveSnapshot(updated);
    return updated;
  }

  async deleteSnapshot(id: string): Promise<void> {
    const key = `snapshot_${id}`;
    await chrome.storage.local.remove(key);

    // Update the index
    const index = await this.getSnapshotIndex();
    const newIndex = index.filter((i) => i !== id);
    await chrome.storage.local.set({ snapshotIndex: newIndex });
  }

  async exportAllData(): Promise<ExportData> {
    const snapshots = await this.getAllSnapshots();
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

  async importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
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
    return chrome.runtime.getURL(assetPath);
  }
}

/**
 * Create a Chrome storage provider instance
 */
export function createChromeStorageProvider(): ChromeStorageProvider {
  return new ChromeStorageProvider();
}
