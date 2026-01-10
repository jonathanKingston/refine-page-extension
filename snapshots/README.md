# Page Snapshots

This directory contains captured page snapshots that can be imported into the extension.

## Capturing Pages

Use the CLI tool to capture pages:

```bash
# Capture a single page
npm run capture:pages -- --urls=https://example.com

# Capture multiple pages
npm run capture:pages -- --urls=https://example.com,https://wikipedia.org/wiki/Pasty

# Use a config file
npm run capture:pages -- --config=./refine-page-screenshots/tools/screenshots/pages.json

# Custom output directory
npm run capture:pages -- --urls=https://example.com --output=./my-snapshots
```

## Files

- `*.html` - Captured page HTML (self-contained with inlined styles)
- `*.json` - Metadata for each captured page (URL, title, capture date, etc.)
- `index.json` - Index of all captured pages

## Importing into Extension

The captured HTML files can be imported into the extension later. The extension's import functionality will convert them to the proper snapshot format.

