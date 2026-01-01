/**
 * Resource URL helpers
 *
 * Allows the same code to run in:
 * - Extension context (chrome.runtime.getURL)
 * - Web/server context (relative URLs)
 * - Hybrid: load specific resources (e.g. iframe annotator) from a 3p base URL
 */
 
declare global {
  // Optional global configuration for non-extension usage.
  // eslint-disable-next-line no-var
  var __REFINE_RESOURCE_BASE_URL__: string | undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  // Ensure it ends with a slash so URL resolution behaves like path joining.
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function getMetaContent(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute('content') ?? null;
}

/**
 * Determine a configured base URL for loading resources.
 *
 * Precedence:
 * - query param `resourceBase`
 * - meta tag: `<meta name="refine-resource-base" content="https://.../">`
 * - global: `globalThis.__REFINE_RESOURCE_BASE_URL__ = "https://.../"`
 */
export function getConfiguredResourceBaseUrl(): string | null {
  try {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = params.get('resourceBase');
      if (fromQuery) return normalizeBaseUrl(fromQuery);
    }
  } catch {
    // ignore
  }

  const fromMeta = getMetaContent('refine-resource-base');
  if (fromMeta) return normalizeBaseUrl(fromMeta);

  try {
    const fromStorage =
      window.localStorage.getItem('refine-resource-base-url') ||
      window.localStorage.getItem('refine-resource-base');
    if (fromStorage) return normalizeBaseUrl(fromStorage);
  } catch {
    // ignore
  }

  if (typeof globalThis !== 'undefined' && typeof globalThis.__REFINE_RESOURCE_BASE_URL__ === 'string') {
    return normalizeBaseUrl(globalThis.__REFINE_RESOURCE_BASE_URL__);
  }

  return null;
}

export function getOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '*';
  }
}

/**
 * Resolve a resource URL, preferring:
 * - an explicitly provided baseUrl
 * - configured resourceBase (see getConfiguredResourceBaseUrl)
 * - extension runtime URL if available
 * - relative URL from current location
 */
export function resolveResourceUrl(resourcePath: string, opts?: { baseUrl?: string | null }): string {
  const providedBase = opts?.baseUrl ? normalizeBaseUrl(opts.baseUrl) : null;
  const configuredBase = getConfiguredResourceBaseUrl();
  const base = providedBase ?? configuredBase;

  if (base) {
    return new URL(resourcePath, base).toString();
  }

  // Extension environment
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(resourcePath);
    }
  } catch {
    // ignore
  }

  // Plain web environment
  return new URL(resourcePath, window.location.href).toString();
}

/**
 * Convenience for the annotator iframe: allow overriding just this resource.
 *
 * Precedence:
 * - query param `annotatorBase` (base URL that contains iframe.html)
 * - otherwise uses resolveResourceUrl("iframe.html")
 */
export function resolveAnnotatorIframeUrl(): string {
  let annotatorBase: string | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    annotatorBase = params.get('annotatorBase');
  } catch {
    // ignore
  }

  if (!annotatorBase) {
    try {
      annotatorBase =
        window.localStorage.getItem('refine-annotator-base-url') ||
        window.localStorage.getItem('refine-annotator-base');
    } catch {
      // ignore
    }
  }

  return resolveResourceUrl('iframe.html', { baseUrl: annotatorBase });
}

