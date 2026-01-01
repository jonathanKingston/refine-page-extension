import JSZip from 'jszip';

import type { ExportData, ExportedSnapshot, Snapshot, ZipExportData, ZipIndexSnapshot } from '@/types';

export type ZipExportOutputType = 'blob' | 'uint8array';

export interface CreateZipExportOptions {
  /**
   * Used to populate `viewerUrl` in the exported index.
   * - Extension: `chrome.runtime.getURL('viewer.html')`
   * - Web: `https://refine.page/viewer`
   */
  viewerUrlBase?: string;
  /**
   * Optional identifier of the exporting app (e.g. extension id).
   */
  exporterId?: string;
  /**
   * Override timestamp used for `exportedAt`.
   */
  exportedAt?: string;
  /**
   * ZIP generation output type.
   */
  outputType?: ZipExportOutputType;
}

export function toZipIndexSnapshot(
  snapshot: Snapshot,
  viewerUrlBase?: string
): ZipIndexSnapshot {
  const { html, ...metadata } = snapshot;
  return {
    ...metadata,
    htmlFile: `html/${snapshot.id}.html`,
    viewerUrl: viewerUrlBase ? `${viewerUrlBase}?id=${snapshot.id}` : undefined,
  };
}

export function toZipExportData(
  snapshots: Snapshot[],
  options: Pick<CreateZipExportOptions, 'viewerUrlBase' | 'exportedAt' | 'exporterId'> = {}
): ZipExportData {
  return {
    version: '1.0.0',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    extensionId: options.exporterId,
    snapshots: snapshots.map((s) => toZipIndexSnapshot(s, options.viewerUrlBase)),
  };
}

export async function createZipExport(
  snapshots: Snapshot[],
  options: Omit<CreateZipExportOptions, 'outputType'> & { outputType?: 'blob' }
): Promise<Blob>;
export async function createZipExport(
  snapshots: Snapshot[],
  options: Omit<CreateZipExportOptions, 'outputType'> & { outputType: 'uint8array' }
): Promise<Uint8Array>;
export async function createZipExport(
  snapshots: Snapshot[],
  options: CreateZipExportOptions = {}
): Promise<Blob | Uint8Array> {
  const zip = new JSZip();
  const htmlFolder = zip.folder('html');

  const indexData = toZipExportData(snapshots, {
    viewerUrlBase: options.viewerUrlBase,
    exporterId: options.exporterId,
    exportedAt: options.exportedAt,
  });

  zip.file('index.json', JSON.stringify(indexData, null, 2));

  for (const snapshot of snapshots) {
    htmlFolder?.file(`${snapshot.id}.html`, snapshot.html);
  }

  const outputType: ZipExportOutputType = options.outputType ?? 'blob';
  if (outputType === 'uint8array') {
    return zip.generateAsync({ type: 'uint8array' });
  }

  return zip.generateAsync({ type: 'blob' });
}

export async function parseZipExport(file: Blob | ArrayBuffer | Uint8Array): Promise<ExportData> {
  const zip =
    file instanceof Uint8Array
      ? await JSZip.loadAsync(file)
      : file instanceof ArrayBuffer
        ? await JSZip.loadAsync(file)
        : await JSZip.loadAsync(file);

  const indexFile = zip.file('index.json');
  if (!indexFile) {
    throw new Error('Invalid ZIP: missing index.json');
  }

  const indexJson = await indexFile.async('string');
  const zipData = JSON.parse(indexJson) as ZipExportData;

  const snapshotsWithHtml: ExportedSnapshot[] = [];
  for (const snapshotMeta of zipData.snapshots) {
    const htmlFile = snapshotMeta.htmlFile || `html/${snapshotMeta.id}.html`;
    const htmlZipFile = zip.file(htmlFile);
    if (!htmlZipFile) continue;

    const html = await htmlZipFile.async('string');
    const { htmlFile: _htmlFile, ...rest } = snapshotMeta;

    snapshotsWithHtml.push({
      ...(rest as unknown as Omit<ExportedSnapshot, 'html'>),
      html,
    });
  }

  return {
    version: zipData.version,
    exportedAt: zipData.exportedAt,
    extensionId: zipData.extensionId,
    snapshots: snapshotsWithHtml,
  };
}

