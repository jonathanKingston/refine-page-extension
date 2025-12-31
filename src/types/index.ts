/**
 * Core types for Page Labeller extension
 */

// Annotation types matching Label Studio style
export type AnnotationType = 'relevant' | 'answer' | 'no_content';

export interface TextAnnotation {
  id: string;
  type: AnnotationType;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  // XPath or CSS selector to locate the element
  selector: {
    type: 'xpath' | 'css' | 'text-position';
    value: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RegionAnnotation {
  id: string;
  type: AnnotationType;
  // Bounding box coordinates (percentage-based for responsiveness)
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  createdAt: string;
  updatedAt: string;
}

// Question/Answer evaluation types
export type AnswerCorrectness = 'correct' | 'incorrect' | 'partial';
export type AnswerInPage = 'yes' | 'no' | 'ambiguous';
export type PageQuality = 'good' | 'broken' | 'partial';

export interface Question {
  id: string;
  query: string;
  expectedAnswer: string;
  // Annotations linked to this question
  annotationIds: string[];
  // Evaluation fields
  evaluation: {
    answerCorrectness?: AnswerCorrectness;
    answerInPage?: AnswerInPage;
    pageQuality?: PageQuality;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: string;
  // Original page URL
  url: string;
  // Page title
  title: string;
  // Captured HTML content (inlined styles, images as data URLs)
  html: string;
  // Viewport dimensions at capture time
  viewport: {
    width: number;
    height: number;
  };
  // All annotations (text and region)
  annotations: {
    text: TextAnnotation[];
    region: RegionAnnotation[];
  };
  // Questions and answers for this snapshot
  questions: Question[];
  // Review status
  status: 'pending' | 'approved' | 'declined' | 'needs_revision';
  // Review notes
  reviewNotes?: string;
  // Metadata
  capturedAt: string;
  updatedAt: string;
  // Tags for organization
  tags: string[];
}

// Export format for backup/portability
export interface ExportData {
  version: string;
  exportedAt: string;
  snapshots: Snapshot[];
}

// Messages between extension components
export type MessageType =
  | 'CAPTURE_PAGE'
  | 'CAPTURE_COMPLETE'
  | 'CAPTURE_ERROR'
  | 'OPEN_VIEWER'
  | 'GET_SNAPSHOTS'
  | 'DELETE_SNAPSHOT'
  | 'UPDATE_SNAPSHOT';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface CapturePageMessage extends ExtensionMessage {
  type: 'CAPTURE_PAGE';
}

export interface CaptureCompleteMessage extends ExtensionMessage {
  type: 'CAPTURE_COMPLETE';
  payload: {
    snapshotId: string;
  };
}

export interface CaptureErrorMessage extends ExtensionMessage {
  type: 'CAPTURE_ERROR';
  payload: {
    error: string;
  };
}
