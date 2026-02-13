/**
 * Integration tests for the offscreen module (message handler + MHTML conversion).
 *
 * These test the offscreen.ts module as a whole, including its message listener
 * registration and MHTML-to-HTML conversion pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mhtml2html before any imports
vi.mock('mhtml2html', () => {
  const convertFn = vi.fn();
  return {
    default: { convert: convertFn },
    convert: convertFn,
  };
});

// Get reference to the mock
import * as mhtml2html from 'mhtml2html';

describe('offscreen module', () => {
  function getListeners() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).chrome.runtime.onMessage._listeners;
  }

  function getLastListener() {
    const l = getListeners();
    return l[l.length - 1];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-install mocks after resetModules
    vi.doMock('mhtml2html', () => {
      const convertFn = vi.fn();
      return {
        default: { convert: convertFn },
        convert: convertFn,
      };
    });

    // Re-install chrome mock (setup.ts runs per-test but resetModules clears it)
    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();

    await import('./offscreen');
  });

  it('should register a message listener on import', () => {
    expect(getListeners().length).toBeGreaterThanOrEqual(1);
  });

  it('should handle CONVERT_MHTML and return converted HTML', async () => {
    const mockDoc = new DOMParser().parseFromString(
      '<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>',
      'text/html'
    );

    const importedMhtml = await import('mhtml2html');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importedMhtml as any).default.convert.mockReturnValue({
      window: { document: mockDoc },
    });

    const sendResponse = vi.fn();
    const listener = getLastListener();
    const result = listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'test-mhtml', baseUrl: 'https://example.com' } },
      {},
      sendResponse
    );

    expect(result).toBe(true); // async response
    expect(sendResponse).toHaveBeenCalledTimes(1);

    const response = sendResponse.mock.calls[0][0];
    expect(response.type).toBe('CONVERT_MHTML_COMPLETE');
    expect(response.payload.html).toContain('<!DOCTYPE html>');
    expect(response.payload.title).toBe('Test Page');
  });

  it('should return error when conversion fails', async () => {
    const importedMhtml = await import('mhtml2html');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importedMhtml as any).default.convert.mockImplementation(() => {
      throw new Error('MHTML parse error');
    });

    const sendResponse = vi.fn();
    const listener = getLastListener();
    listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'bad-mhtml' } },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({
      type: 'CONVERT_MHTML_ERROR',
      payload: { error: 'MHTML parse error' },
    });
  });

  it('should return error when mhtml2html returns null document', async () => {
    const importedMhtml = await import('mhtml2html');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importedMhtml as any).default.convert.mockReturnValue({
      window: { document: null },
    });

    const sendResponse = vi.fn();
    const listener = getLastListener();
    listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'empty' } },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONVERT_MHTML_ERROR',
        payload: expect.objectContaining({
          error: expect.stringContaining('conversion failed'),
        }),
      })
    );
  });

  it('should return error when convert function is not available', async () => {
    // When mhtml2html mock doesn't define the convert function,
    // the source code catches the error and sends CONVERT_MHTML_ERROR.
    vi.resetModules();
    vi.doMock('mhtml2html', () => ({
      default: {},
      convert: undefined,
    }));

    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();

    await import('./offscreen');

    const listener = getLastListener();
    const sendResponse = vi.fn();

    listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'test' } },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONVERT_MHTML_ERROR',
      })
    );
  });

  it('should ignore non-CONVERT_MHTML messages', () => {
    const sendResponse = vi.fn();
    const listener = getLastListener();
    const result = listener({ type: 'OTHER_MESSAGE' }, {}, sendResponse);
    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('should default to "Untitled" when document has no title', async () => {
    const mockDoc = new DOMParser().parseFromString(
      '<html><head></head><body></body></html>',
      'text/html'
    );

    const importedMhtml = await import('mhtml2html');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (importedMhtml as any).default.convert.mockReturnValue({
      window: { document: mockDoc },
    });

    const sendResponse = vi.fn();
    const listener = getLastListener();
    listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'test' } },
      {},
      sendResponse
    );

    const response = sendResponse.mock.calls[0][0];
    expect(response.payload.title).toBe('Untitled');
  });

  it('should use default.convert over named convert', async () => {
    // The source checks (mhtml2html as any).default?.convert first,
    // then (mhtml2html as any).convert, then mhtml2html.convert
    vi.resetModules();

    const defaultConvert = vi.fn();
    vi.doMock('mhtml2html', () => ({
      default: { convert: defaultConvert },
      convert: vi.fn(() => { throw new Error('should not use named'); }),
    }));

    const { installMockChrome } = await import('../test/chrome-mock');
    installMockChrome();

    await import('./offscreen');

    const mockDoc = new DOMParser().parseFromString(
      '<html><head><title>Default</title></head><body></body></html>',
      'text/html'
    );
    defaultConvert.mockReturnValue({ window: { document: mockDoc } });

    const listener = getLastListener();
    const sendResponse = vi.fn();

    listener(
      { type: 'CONVERT_MHTML', payload: { mhtmlText: 'test' } },
      {},
      sendResponse
    );

    expect(defaultConvert).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONVERT_MHTML_COMPLETE',
        payload: expect.objectContaining({
          title: 'Default',
        }),
      })
    );
  });
});
