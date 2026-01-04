/**
 * Core types for refine.page extension
 * Uses W3C Web Annotation format for compatibility with annotation libraries
 */

// Annotation types/purposes matching Label Studio style
export type AnnotationPurpose = 'relevant' | 'answer';

// W3C Web Annotation selectors
export interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface TextPositionSelector {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

export interface FragmentSelector {
  type: 'FragmentSelector';
  conformsTo: 'http://www.w3.org/TR/media-frags/';
  value: string; // xywh=x,y,width,height format (pixel or percent)
}

export type Selector = TextQuoteSelector | TextPositionSelector | FragmentSelector;

// W3C Web Annotation body
export interface AnnotationBody {
  type: 'TextualBody';
  purpose: 'tagging' | 'commenting' | 'classifying';
  value: AnnotationPurpose;
}

// W3C Web Annotation target
export interface AnnotationTarget {
  source: string; // The snapshot ID or URL
  selector: Selector | Selector[];
}

// W3C Web Annotation format
export interface WebAnnotation {
  '@context': 'http://www.w3.org/ns/anno.jsonld';
  id: string;
  type: 'Annotation';
  body: AnnotationBody | AnnotationBody[];
  target: AnnotationTarget;
  created: string;
  modified: string;
  // Custom extension for our purposes
  'x-refine-page'?: {
    annotationType: 'text' | 'region';
  };
}

// Legacy TextAnnotation format (for backwards compatibility)
export type AnnotationType = AnnotationPurpose;

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
  // Optional W3C annotation reference
  w3cAnnotation?: WebAnnotation;
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
  // Target element (image, canvas, etc.)
  targetSelector?: string;
  createdAt: string;
  updatedAt: string;
  // Optional W3C annotation reference
  w3cAnnotation?: WebAnnotation;
}

// Question/Answer evaluation types
export type AnswerCorrectness = 'correct' | 'incorrect' | 'partial';
export type AnswerInPage = 'yes' | 'no' | 'unclear';
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
  // Auto-detected element marks (from webmarker)
  elementMarks?: ElementMark[];
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

// Snapshot with viewer URL for export
export interface ExportedSnapshot extends Snapshot {
  viewerUrl?: string;
}

// Snapshot metadata for ZIP index (HTML stored separately)
export interface ZipIndexSnapshot extends Omit<Snapshot, 'html'> {
  htmlFile: string;
  viewerUrl?: string;
}

// Export format for backup/portability
export interface ExportData {
  version: string;
  exportedAt: string;
  extensionId?: string;
  snapshots: ExportedSnapshot[];
}

// ZIP export format with HTML in separate files
export interface ZipExportData {
  version: string;
  exportedAt: string;
  extensionId?: string;
  snapshots: ZipIndexSnapshot[];
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

// Helper function to convert our annotation to W3C format
export function toW3CAnnotation(
  annotation: TextAnnotation | RegionAnnotation,
  snapshotId: string
): WebAnnotation {
  const isText = 'selectedText' in annotation;

  let selector: Selector;
  if (isText) {
    const textAnn = annotation as TextAnnotation;
    selector = {
      type: 'TextQuoteSelector',
      exact: textAnn.selectedText,
    };
  } else {
    const regionAnn = annotation as RegionAnnotation;
    selector = {
      type: 'FragmentSelector',
      conformsTo: 'http://www.w3.org/TR/media-frags/',
      value: `xywh=percent:${regionAnn.bounds.x},${regionAnn.bounds.y},${regionAnn.bounds.width},${regionAnn.bounds.height}`,
    };
  }

  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: annotation.id,
    type: 'Annotation',
    body: {
      type: 'TextualBody',
      purpose: 'tagging',
      value: annotation.type,
    },
    target: {
      source: snapshotId,
      selector,
    },
    created: annotation.createdAt,
    modified: annotation.updatedAt,
    'x-refine-page': {
      annotationType: isText ? 'text' : 'region',
    },
  };
}

// Element mark (from webmarker auto-detection)
export interface ElementMark {
  id: string;
  // The numeric label from webmarker (e.g., "0", "1", "2")
  label: string;
  // User-assigned name for this element
  name: string;
  // Element type (tag name)
  tagName: string;
  // Element text content preview
  textPreview: string;
  // CSS selector to locate the element
  selector: string;
  // Bounding box (for display/debugging)
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  createdAt: string;
  updatedAt: string;
}

// Helper to convert W3C annotation back to our format
export function fromW3CAnnotation(w3c: WebAnnotation): TextAnnotation | RegionAnnotation | null {
  const body = Array.isArray(w3c.body) ? w3c.body[0] : w3c.body;
  const selector = Array.isArray(w3c.target.selector)
    ? w3c.target.selector[0]
    : w3c.target.selector;

  if (selector.type === 'TextQuoteSelector') {
    return {
      id: w3c.id,
      type: body.value as AnnotationType,
      startOffset: 0, // Will be computed by the library
      endOffset: 0,
      selectedText: selector.exact,
      selector: {
        type: 'text-position',
        value: '0:0',
      },
      createdAt: w3c.created,
      updatedAt: w3c.modified,
      w3cAnnotation: w3c,
    };
  } else if (selector.type === 'FragmentSelector') {
    // Parse xywh=percent:x,y,w,h format
    const match = selector.value.match(/xywh=(?:percent:)?([^,]+),([^,]+),([^,]+),([^,]+)/);
    if (!match) return null;

    return {
      id: w3c.id,
      type: body.value as AnnotationType,
      bounds: {
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
        width: parseFloat(match[3]),
        height: parseFloat(match[4]),
      },
      createdAt: w3c.created,
      updatedAt: w3c.modified,
      w3cAnnotation: w3c,
    };
  }

  return null;
}
