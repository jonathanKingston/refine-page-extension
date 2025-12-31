/**
 * IndexedDB storage layer using idb library
 * Provides portable, exportable storage for snapshots
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Snapshot, ExportData } from '@/types';

interface PageLabellerDB extends DBSchema {
  snapshots: {
    key: string;
    value: Snapshot;
    indexes: {
      'by-url': string;
      'by-status': string;
      'by-capturedAt': string;
    };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

const DB_NAME = 'page-labeller';
const DB_VERSION = 1;

let dbInstance: IDBPDatabase<PageLabellerDB> | null = null;

export async function getDB(): Promise<IDBPDatabase<PageLabellerDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<PageLabellerDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Create snapshots store
      if (!db.objectStoreNames.contains('snapshots')) {
        const snapshotStore = db.createObjectStore('snapshots', { keyPath: 'id' });
        snapshotStore.createIndex('by-url', 'url');
        snapshotStore.createIndex('by-status', 'status');
        snapshotStore.createIndex('by-capturedAt', 'capturedAt');
      }

      // Create settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    },
  });

  return dbInstance;
}

// Snapshot CRUD operations
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const db = await getDB();
  await db.put('snapshots', snapshot);
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  const db = await getDB();
  return db.get('snapshots', id);
}

export async function getAllSnapshots(): Promise<Snapshot[]> {
  const db = await getDB();
  return db.getAll('snapshots');
}

export async function getSnapshotsByStatus(status: Snapshot['status']): Promise<Snapshot[]> {
  const db = await getDB();
  return db.getAllFromIndex('snapshots', 'by-status', status);
}

export async function deleteSnapshot(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('snapshots', id);
}

export async function updateSnapshot(id: string, updates: Partial<Snapshot>): Promise<Snapshot | undefined> {
  const db = await getDB();
  const existing = await db.get('snapshots', id);
  if (!existing) return undefined;

  const updated: Snapshot = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await db.put('snapshots', updated);
  return updated;
}

// Export/Import for portability
export async function exportAllData(): Promise<ExportData> {
  const snapshots = await getAllSnapshots();
  return {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    snapshots,
  };
}

export async function importData(data: ExportData): Promise<{ imported: number; skipped: number }> {
  const db = await getDB();
  let imported = 0;
  let skipped = 0;

  for (const snapshot of data.snapshots) {
    const existing = await db.get('snapshots', snapshot.id);
    if (existing) {
      skipped++;
    } else {
      await db.put('snapshots', snapshot);
      imported++;
    }
  }

  return { imported, skipped };
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  await db.clear('snapshots');
  await db.clear('settings');
}

// Settings operations
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const result = await db.get('settings', key);
  return result as T | undefined;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDB();
  await db.put('settings', { key, value });
}
