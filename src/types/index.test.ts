/**
 * Unit tests for types/index.ts helper functions
 */

import { describe, it, expect } from 'vitest';
import {
  toW3CAnnotation,
  fromW3CAnnotation,
  type TextAnnotation,
  type RegionAnnotation,
  type WebAnnotation,
} from './index';

describe('toW3CAnnotation', () => {
  it('should convert text annotation to W3C format', () => {
    const textAnnotation: TextAnnotation = {
      id: 'test-1',
      type: 'relevant',
      startOffset: 0,
      endOffset: 10,
      selectedText: 'Hello World',
      selector: {
        type: 'text-position',
        value: '0:10',
      },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const result = toW3CAnnotation(textAnnotation, 'snapshot-1');

    expect(result).toMatchObject({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test-1',
      type: 'Annotation',
      body: {
        type: 'TextualBody',
        purpose: 'tagging',
        value: 'relevant',
      },
      target: {
        source: 'snapshot-1',
        selector: {
          type: 'TextQuoteSelector',
          exact: 'Hello World',
        },
      },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      'x-refine-page': {
        annotationType: 'text',
      },
    });
  });

  it('should convert region annotation to W3C format', () => {
    const regionAnnotation: RegionAnnotation = {
      id: 'test-2',
      type: 'answer',
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const result = toW3CAnnotation(regionAnnotation, 'snapshot-1');

    expect(result).toMatchObject({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test-2',
      type: 'Annotation',
      body: {
        type: 'TextualBody',
        purpose: 'tagging',
        value: 'answer',
      },
      target: {
        source: 'snapshot-1',
        selector: {
          type: 'FragmentSelector',
          conformsTo: 'http://www.w3.org/TR/media-frags/',
          value: 'xywh=percent:10,20,100,50',
        },
      },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      'x-refine-page': {
        annotationType: 'region',
      },
    });
  });
});

describe('fromW3CAnnotation', () => {
  it('should convert W3C text annotation to TextAnnotation', () => {
    const w3cAnnotation: WebAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test-1',
      type: 'Annotation',
      body: {
        type: 'TextualBody',
        purpose: 'tagging',
        value: 'relevant',
      },
      target: {
        source: 'snapshot-1',
        selector: {
          type: 'TextQuoteSelector',
          exact: 'Hello World',
        },
      },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      'x-refine-page': {
        annotationType: 'text',
      },
    };

    const result = fromW3CAnnotation(w3cAnnotation);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      id: 'test-1',
      type: 'relevant',
      selectedText: 'Hello World',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    expect('selectedText' in result!).toBe(true);
  });

  it('should convert W3C region annotation to RegionAnnotation', () => {
    const w3cAnnotation: WebAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test-2',
      type: 'Annotation',
      body: {
        type: 'TextualBody',
        purpose: 'tagging',
        value: 'answer',
      },
      target: {
        source: 'snapshot-1',
        selector: {
          type: 'FragmentSelector',
          conformsTo: 'http://www.w3.org/TR/media-frags/',
          value: 'xywh=percent:10,20,100,50',
        },
      },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      'x-refine-page': {
        annotationType: 'region',
      },
    };

    const result = fromW3CAnnotation(w3cAnnotation);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      id: 'test-2',
      type: 'answer',
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    expect('bounds' in result!).toBe(true);
  });

  it('should return null for invalid fragment selector', () => {
    const w3cAnnotation: WebAnnotation = {
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      id: 'test-3',
      type: 'Annotation',
      body: {
        type: 'TextualBody',
        purpose: 'tagging',
        value: 'answer',
      },
      target: {
        source: 'snapshot-1',
        selector: {
          type: 'FragmentSelector',
          conformsTo: 'http://www.w3.org/TR/media-frags/',
          value: 'invalid-format',
        },
      },
      created: '2024-01-01T00:00:00Z',
      modified: '2024-01-01T00:00:00Z',
      'x-refine-page': {
        annotationType: 'region',
      },
    };

    const result = fromW3CAnnotation(w3cAnnotation);

    expect(result).toBeNull();
  });
});
