/**
 * mhtml2html
 *
 * @Author : Mayank Sindwani
 * @Date   : 2016-09-05
 * @Description : Converts mhtml to html.
 *
 * Licensed under the MIT License
 * Copyright(c) 2016 Mayank Sindwani
 **/

/**
 * KNOWN LIMITATIONS:
 *
 * 1. MHTML Capture (Chrome limitation, not fixable here):
 *    - adoptedStyleSheets: Web components using `new CSSStyleSheet()` and
 *      `shadowRoot.adoptedStyleSheets` will have their CSS missing from MHTML.
 *    - Font files: Fonts referenced in @font-face are not captured in MHTML.
 *    - These are Chrome Page.captureSnapshot limitations.
 *
 * 2. jsdom limitations (worked around in this code):
 *    - Declarative Shadow DOM: jsdom consumes light DOM children when parsing
 *      <template shadowrootmode>. We work around this by renaming attributes.
 *    - CSS Custom Properties: jsdom's CSSOM doesn't support custom properties.
 *      We use getAttribute/setAttribute instead of style.cssText.
 */

import QuotedPrintable from 'quoted-printable';
import Base64 from 'base-64';

// Asserts a condition (throws on failure).
function assert(condition, error) {
    if (!condition) {
        throw new Error(error);
    }
    return true;
}

// Soft assert - logs warning instead of throwing (for non-critical failures).
function softAssert(condition, warning) {
    if (!condition) {
        console.warn(`[mhtml2html] ${warning}`);
    }
    return condition;
}

// Default DOM parser (browser only).
function defaultDOMParser(asset) {
    assert(typeof DOMParser !== 'undefined', 'No DOM parser available');
    return {
        window: {
            document: new DOMParser().parseFromString(asset, 'text/html'),
        },
    };
}

/**
 * Normalize line endings to LF.
 * IE and some older software use CRLF (\r\n) which can cause parsing issues.
 */
function normalizeLineEndings(str) {
    return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Extract charset from Content-Type header.
 * e.g., "text/html; charset=windows-1252" -> "windows-1252"
 */
function extractCharset(contentType) {
    if (!contentType) return null;
    const match = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Extract MIME type from Content-Type header (without charset).
 * e.g., "text/html; charset=utf-8" -> "text/html"
 */
function extractMimeType(contentType) {
    if (!contentType) return null;
    return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Decode text content with charset fallback.
 * NOTE: This function only handles charset conversion for text content.
 * Transfer encoding (base64, quoted-printable) is handled elsewhere:
 * - quoted-printable: decoded line-by-line in getLine()
 * - base64: kept as-is for data URI usage in convert()
 */
function decodeWithCharset(data, charset) {
    // Try to decode charset if specified and not UTF-8
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
        // In Node.js, we can use TextDecoder for common charsets
        if (typeof TextDecoder !== 'undefined') {
            try {
                // TextDecoder expects a Uint8Array, so we need to convert
                const bytes = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) {
                    bytes[i] = data.charCodeAt(i) & 0xff;
                }
                const decoder = new TextDecoder(charset);
                return decoder.decode(bytes);
            } catch (e) {
                // Charset not supported, fall through to default handling
                console.warn(`[mhtml2html] TextDecoder failed for charset ${charset}:`, e.message);
            }
        }
    }

    // Default: try to decode as UTF-8 using escape/unescape trick
    try {
        return decodeURIComponent(escape(data));
    } catch (e) {
        // If that fails, return as-is
        return data;
    }
}

// Returns an absolute url from base and relative paths.
function absoluteURL(base, relative) {
    if (relative.indexOf('http://') === 0 || relative.indexOf('https://') === 0) {
        return relative;
    }

    const stack = base.split('/');
    const parts = relative.split('/');

    stack.pop();

    for (let i = 0; i < parts.length; i++) {
        if (parts[i] == '.') {
            continue;
        } else if (parts[i] == '..') {
            stack.pop();
        } else {
            stack.push(parts[i]);
        }
    }

    return stack.join('/');
}

// Try to find an asset in media using multiple URL resolution strategies.
// Handles relative URLs, root-relative URLs, and filename matching.
function findAsset(media, base, reference) {
    const cleanRef = reference.replace(/(\"|\')/g, '');

    // Direct lookup
    if (media[cleanRef]) {
        return { path: cleanRef, entry: media[cleanRef] };
    }

    // Resolve relative to base
    const absolutePath = absoluteURL(base, cleanRef);
    if (media[absolutePath]) {
        return { path: absolutePath, entry: media[absolutePath] };
    }

    // Root-relative URLs (starting with /)
    if (cleanRef.startsWith('/')) {
        try {
            const baseUrl = new URL(base);
            const fullUrl = baseUrl.origin + cleanRef;
            if (media[fullUrl]) {
                return { path: fullUrl, entry: media[fullUrl] };
            }
        } catch (e) {
            // base might not be a valid URL
        }
    }

    // Filename matching (last resort)
    const filename = cleanRef.split('/').pop();
    if (filename && filename.length > 3) {
        for (const key of Object.keys(media)) {
            if (key.endsWith('/' + filename) || key.endsWith(filename)) {
                return { path: key, entry: media[key] };
            }
        }
    }

    return null;
}

// Decode and process CSS from a media entry, replacing url() references.
function processCSS(media, path) {
    const entry = media[path];
    if (!entry || !entry.type.includes('css')) return null;

    const decoded = entry.encoding === 'base64' ? Base64.decode(entry.data) : entry.data;

    return replaceReferences(media, path, decoded);
}

// Replace asset references with the corresponding data URIs.
function replaceReferences(media, base, css) {
    const CSS_URL_RULE = 'url(';
    let reference, i;

    for (i = 0; (i = css.indexOf(CSS_URL_RULE, i)) > 0; i += reference.length) {
        i += CSS_URL_RULE.length;
        reference = css.substring(i, css.indexOf(')', i));

        const found = findAsset(media, base, reference);
        if (found != null) {
            const { path, entry } = found;
            let assetData;
            if (entry.type.includes('css')) {
                assetData = processCSS(media, path);
            } else {
                assetData = entry.encoding === 'base64' ? Base64.decode(entry.data) : entry.data;
            }
            try {
                const embeddedAsset = `'data:${entry.type};base64,${Base64.encode(assetData)}'`;
                css = `${css.substring(0, i)}${embeddedAsset}${css.substring(i + reference.length)}`;
            } catch (e) {
                console.warn(e);
            }
        }
    }
    return css;
}

/**
 * Process Declarative Shadow DOM templates.
 *
 * JSDOM WORKAROUND: jsdom has partial Declarative Shadow DOM support that
 * consumes light DOM children incorrectly. We rename shadowrootmode/shadowmode
 * attributes to data-* before parsing, then process templates here.
 *
 * If jsdom fixes this, this function could be simplified or removed.
 * If Chrome changes MHTML format, this would still be needed for jsdom.
 */
function processDeclarativeShadowDOM(element, documentElem) {
    let shadowTemplate = null;
    for (const child of element.children) {
        if (
            child.tagName === 'TEMPLATE' &&
            (child.hasAttribute('data-shadowrootmode') || child.hasAttribute('data-shadowmode'))
        ) {
            shadowTemplate = child;
            break;
        }
    }
    if (!shadowTemplate) return false;

    // Check if template has actual content vs just slots
    const templateContent = shadowTemplate.innerHTML;
    const hasOnlySlots = !templateContent
        .replace(/<slot[^>]*>.*?<\/slot>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();

    // Collect light DOM children (everything except the template)
    const lightDOMChildren = [];
    for (const child of element.children) {
        if (child !== shadowTemplate) {
            lightDOMChildren.push(child);
        }
    }

    if (hasOnlySlots || lightDOMChildren.length > 0) {
        // Template has slots or light DOM exists - just remove template, keep light DOM
        shadowTemplate.parentNode.removeChild(shadowTemplate);
    } else {
        // Template has actual content with no light DOM - extract it
        const fragment = documentElem.createDocumentFragment();
        const contentNodes = shadowTemplate.content
            ? shadowTemplate.content.childNodes
            : shadowTemplate.childNodes;

        Array.from(contentNodes).forEach((node) => {
            if (node.nodeType !== 8) {
                // Skip comment nodes
                fragment.appendChild(node.cloneNode(true));
            }
        });

        shadowTemplate.parentNode.removeChild(shadowTemplate);
        element.appendChild(fragment);
    }

    // Remove 'loaded' attribute so CSS hide rules apply
    if (element.hasAttribute('loaded')) {
        element.removeAttribute('loaded');
    }

    return true;
}

// Converts the provided asset to a data URI based on the encoding.
function convertAssetToDataURI(asset) {
    switch (asset.encoding) {
        case 'quoted-printable':
            return `data:${asset.type};utf8,${escape(QuotedPrintable.decode(asset.data))}`;
        case 'base64':
            return `data:${asset.type};base64,${asset.data}`;
        default:
            return `data:${asset.type};base64,${Base64.encode(asset.data)}`;
    }
}

/**
 * Update inline styles, preserving CSS custom properties.
 *
 * JSDOM WORKAROUND: jsdom's CSSOM doesn't support CSS custom properties.
 * Using style.cssText strips properties like --my-var: value.
 * We use getAttribute/setAttribute to preserve the raw style text.
 *
 * If jsdom adds CSS custom property support, this could use style.cssText.
 */
function updateInlineStyle(element, media, base) {
    const inlineStyle = element.getAttribute && element.getAttribute('style');
    if (inlineStyle) {
        element.setAttribute('style', replaceReferences(media, base, inlineStyle));
    }
}

// Main module.
const mhtml2html = {
    /**
     * Parse
     *
     * Description: Returns an object representing the mhtml and its resources.
     * @param {mhtml} // The mhtml string.
     * @param {options.htmlOnly} // A flag to determine which parsed object to return.
     * @param {options.parseDOM} // The callback to parse an HTML string.
     * @returns an html document without resources if htmlOnly === true; an MHTML parsed object otherwise.
     */
    parse: (mhtml, { htmlOnly = false, parseDOM = defaultDOMParser } = {}) => {
        const MHTML_FSM = {
            MHTML_HEADERS: 0,
            MTHML_CONTENT: 1,
            MHTML_DATA: 2,
            MHTML_END: 3,
        };

        let asset, headers, content, media, frames; // Record-keeping.
        let location, encoding, type, mimeType, charset, id; // Content properties.
        let state, key, next, index, i, l; // States.
        let boundary; // Boundaries.

        headers = {};
        content = {};
        media = {};
        frames = {};

        // Normalize line endings (IE compatibility)
        mhtml = normalizeLineEndings(mhtml);

        // Initial state and index.
        state = MHTML_FSM.MHTML_HEADERS;
        i = l = 0;

        // Safely check if we're at EOF
        function isEOF() {
            return i >= mhtml.length - 1;
        }

        // Discards characters until a non-whitespace character is encountered.
        function trim() {
            while (!isEOF() && /\s/.test(mhtml[i])) {
                if (mhtml[++i] == '\n') {
                    l++;
                }
            }
        }

        // Returns the next line from the index.
        function getLine(enc) {
            const j = i;

            // Wait until a newline character is encountered or when we exceed the str length.
            while (mhtml[i] !== '\n' && !isEOF()) {
                i++;
            }
            i++;
            l++;

            let line = mhtml.substring(j, i);

            // Return the (decoded) line.
            if (enc === 'quoted-printable') {
                try {
                    return QuotedPrintable.decode(line);
                } catch (e) {
                    return line;
                }
            }
            if (enc === 'base64') {
                return line.trim();
            }
            return line;
        }

        // Splits headers from the first instance of ':'.
        function splitHeaders(line, obj) {
            const m = line.indexOf(':');
            if (m > -1) {
                key = line.substring(0, m).trim();
                obj[key] = line.substring(m + 1, line.length).trim();
            } else if (typeof key !== 'undefined') {
                // Continuation of previous header
                obj[key] += line.trim();
            }
            // If key is undefined and no colon found, ignore the line (robustness)
        }

        while (state != MHTML_FSM.MHTML_END && !isEOF()) {
            switch (state) {
                // Fetch document headers including the boundary to use.
                case MHTML_FSM.MHTML_HEADERS: {
                    next = getLine();
                    // Use a new line or null character to determine when we should
                    // stop processing headers.
                    if (next != 0 && next != '\n' && next.trim() !== '') {
                        splitHeaders(next, headers);
                    } else {
                        if (
                            !softAssert(
                                typeof headers['Content-Type'] !== 'undefined',
                                `Missing document content type; Line ${l}`
                            )
                        ) {
                            state = MHTML_FSM.MHTML_END;
                            break;
                        }

                        const matches = headers['Content-Type'].match(/boundary=(.*)/m);

                        if (
                            !softAssert(
                                matches != null,
                                `Missing boundary from document headers; Line ${l}`
                            )
                        ) {
                            state = MHTML_FSM.MHTML_END;
                            break;
                        }

                        boundary = matches[1].replace(/\"/g, '');

                        trim();
                        if (isEOF()) {
                            state = MHTML_FSM.MHTML_END;
                            break;
                        }

                        next = getLine();

                        // Expect the next boundary to appear (soft check).
                        if (!next.includes(boundary)) {
                            console.warn(
                                `[mhtml2html] Expected boundary at line ${l}, continuing anyway`
                            );
                        }
                        content = {};
                        state = MHTML_FSM.MTHML_CONTENT;
                    }
                    break;
                }

                // Parse and store content headers.
                case MHTML_FSM.MTHML_CONTENT: {
                    next = getLine();

                    // Use a new line or null character to determine when we should
                    // stop processing headers.
                    if (next != 0 && next != '\n' && next.trim() !== '') {
                        splitHeaders(next, content);
                    } else {
                        encoding = content['Content-Transfer-Encoding'];
                        type = content['Content-Type'];
                        id = content['Content-ID'];
                        location = content['Content-Location'];

                        // Extract MIME type and charset from Content-Type
                        mimeType = extractMimeType(type) || type;
                        charset = extractCharset(type);

                        // Assume the first boundary to be the document.
                        if (typeof index === 'undefined') {
                            index = location;
                            // Soft check for HTML - some MHTML files may have text/html with charset
                            if (
                                !softAssert(
                                    typeof index !== 'undefined' &&
                                        (mimeType === 'text/html' ||
                                            (type && type.includes('text/html'))),
                                    `Index not found or not HTML; Line ${l}`
                                )
                            ) {
                                // Try to continue anyway if we have a location
                                if (typeof location !== 'undefined') {
                                    index = location;
                                }
                            }
                        }

                        // Use defaults for missing headers (robustness)
                        if (typeof encoding === 'undefined') {
                            encoding = 'quoted-printable'; // Common default
                            console.warn(
                                `[mhtml2html] Missing Content-Transfer-Encoding at line ${l}, defaulting to quoted-printable`
                            );
                        }

                        if (typeof type === 'undefined') {
                            type = 'application/octet-stream';
                            mimeType = type;
                            console.warn(
                                `[mhtml2html] Missing Content-Type at line ${l}, defaulting to application/octet-stream`
                            );
                        }

                        // Skip if no ID or location (can't reference it anyway)
                        if (typeof id === 'undefined' && typeof location === 'undefined') {
                            console.warn(
                                `[mhtml2html] Skipping content without ID or location at line ${l}`
                            );
                            trim();
                            content = {};
                            // Skip to next boundary
                            while (!isEOF() && !getLine().includes(boundary)) {
                                // Skip data
                            }
                            state = isEOF() ? MHTML_FSM.MHTML_END : MHTML_FSM.MTHML_CONTENT;
                            break;
                        }

                        asset = {
                            encoding: encoding,
                            type: mimeType || type,
                            charset: charset,
                            data: '',
                            id: id,
                        };

                        // Keep track of frames by ID.
                        if (typeof id !== 'undefined') {
                            frames[id] = asset;
                        }

                        // Keep track of resources by location.
                        if (
                            typeof location !== 'undefined' &&
                            typeof media[location] === 'undefined'
                        ) {
                            media[location] = asset;
                        }

                        trim();
                        content = {};
                        state = MHTML_FSM.MHTML_DATA;
                    }
                    break;
                }

                // Map data to content.
                case MHTML_FSM.MHTML_DATA: {
                    next = getLine(encoding);

                    // Build the decoded string.
                    while (!isEOF() && !next.includes(boundary)) {
                        asset.data += next;
                        next = getLine(encoding);
                    }

                    // Decode charset for non-base64 content
                    // (base64 data stays encoded for data URI usage in convert)
                    if (encoding !== 'base64') {
                        asset.data = decodeWithCharset(asset.data, asset.charset);
                    }

                    // Ignore assets if 'htmlOnly' is set.
                    if (htmlOnly === true && typeof index !== 'undefined') {
                        return parseDOM(asset.data);
                    }

                    // Set the finishing state if there are no more characters.
                    state = isEOF() ? MHTML_FSM.MHTML_END : MHTML_FSM.MTHML_CONTENT;
                    break;
                }
            }
        }

        return {
            frames: frames,
            media: media,
            index: index,
        };
    },

    /**
     * Convert
     *
     * Description: Accepts an mhtml string or parsed object and returns the converted html.
     * @param {mhtml} // The mhtml string or object.
     * @param {options.convertIframes} // Whether or not to include iframes in the converted response (defaults to false).
     * @param {options.parseDOM} // The callback to parse an HTML string.
     * @returns an html document element.
     */
    convert: (mhtml, { convertIframes = false, parseDOM = defaultDOMParser } = {}) => {
        let index, media, frames;
        let style, base, img;
        let href, src;

        if (typeof mhtml === 'string') {
            mhtml = mhtml2html.parse(mhtml);
        } else {
            assert(typeof mhtml === 'object', 'Expected argument of type string or object');
        }

        frames = mhtml.frames;
        media = mhtml.media;
        index = mhtml.index;

        assert(typeof frames === 'object', 'MHTML error: invalid frames');
        assert(typeof media === 'object', 'MHTML error: invalid media');
        assert(typeof index === 'string', 'MHTML error: invalid index');
        assert(
            media[index] &&
                (media[index].type === 'text/html' || media[index].type.includes('html')),
            'MHTML error: invalid index'
        );

        // JSDOM WORKAROUND: Rename shadow DOM attributes before parsing
        // to prevent jsdom from consuming light DOM children incorrectly.
        let htmlContent = media[index].data
            .replace(/shadowrootmode=/gi, 'data-shadowrootmode=')
            .replace(/shadowmode=/gi, 'data-shadowmode=');

        const dom = parseDOM(htmlContent);
        const documentElem = dom.window.document;
        const nodes = [documentElem];

        // Merge resources into the document.
        while (nodes.length) {
            const childNode = nodes.shift();

            childNode.childNodes.forEach(function (child) {
                if (child.getAttribute) {
                    href = child.getAttribute('href');
                    src = child.getAttribute('src');
                }
                if (child.removeAttribute) {
                    child.removeAttribute('integrity');
                }

                // Process Declarative Shadow DOM if present
                if (child.children) {
                    for (const grandchild of child.children) {
                        if (
                            grandchild.tagName === 'TEMPLATE' &&
                            (grandchild.hasAttribute('data-shadowrootmode') ||
                                grandchild.hasAttribute('data-shadowmode'))
                        ) {
                            processDeclarativeShadowDOM(child, documentElem);
                            break;
                        }
                    }
                }

                switch (child.tagName) {
                    case 'HEAD':
                        base = documentElem.createElement('base');
                        base.setAttribute('target', '_parent');
                        child.insertBefore(base, child.firstChild);
                        break;

                    case 'LINK': {
                        // Only process rel="stylesheet", skip alternate stylesheets
                        const rel = child.getAttribute('rel');
                        if (
                            rel === 'stylesheet' &&
                            media[href] &&
                            media[href].type.includes('css')
                        ) {
                            style = documentElem.createElement('style');
                            style.type = 'text/css';
                            style.appendChild(documentElem.createTextNode(processCSS(media, href)));
                            childNode.replaceChild(style, child);
                        }
                        break;
                    }

                    case 'STYLE':
                        style = documentElem.createElement('style');
                        style.type = 'text/css';
                        style.appendChild(
                            documentElem.createTextNode(
                                replaceReferences(media, index, child.innerHTML)
                            )
                        );
                        childNode.replaceChild(style, child);
                        break;

                    case 'IMG':
                        img = null;
                        if (media[src] && media[src].type.includes('image')) {
                            try {
                                img = convertAssetToDataURI(media[src]);
                            } catch (e) {
                                console.warn(e);
                            }
                            if (img !== null) {
                                child.setAttribute('src', img);
                            }
                        }
                        updateInlineStyle(child, media, index);
                        break;

                    case 'IFRAME':
                        if (convertIframes === true && src) {
                            const id = `<${src.split('cid:')[1]}>`;
                            const frame = frames[id];

                            if (
                                frame &&
                                (frame.type === 'text/html' || frame.type.includes('html'))
                            ) {
                                const iframe = mhtml2html.convert(
                                    {
                                        media: Object.assign({}, media, {
                                            [id]: frame,
                                        }),
                                        frames: frames,
                                        index: id,
                                    },
                                    { convertIframes, parseDOM }
                                );
                                child.src = `data:text/html;charset=utf-8,${encodeURIComponent(
                                    iframe.window.document.documentElement.outerHTML
                                )}`;
                            }
                        }
                        break;

                    default:
                        updateInlineStyle(child, media, index);
                        break;
                }
                nodes.push(child);
            });
        }
        return dom;
    },
};

export default mhtml2html;
export const { parse, convert } = mhtml2html;
