# Build Configuration: Excluding Dev-Only Screenshot Code

This document shows how to ensure `demo.html` and any screenshot-related code never makes it into production builds.

## Strategy Overview

There are two layers of protection:

1. **File exclusion**: Don't copy `demo.html` to the production build output
2. **Code elimination**: Remove any dev-only code paths from the bundle

---

## Method 1: Vite Configuration

```javascript
// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  
  return {
    build: {
      rollupOptions: {
        input: {
          // Always include these
          popup: resolve(__dirname, 'src/popup.html'),
          options: resolve(__dirname, 'src/options.html'),
          background: resolve(__dirname, 'src/background.ts'),
          
          // Only include demo.html in dev builds
          ...(isDev && {
            demo: resolve(__dirname, 'src/demo.html'),
          }),
        },
      },
    },
    
    define: {
      // This flag can be used in code to conditionally include dev features
      __DEV_SCREENSHOTS__: JSON.stringify(isDev),
    },
  };
});
```

### Usage in code:

```typescript
// This entire block gets removed in production by dead code elimination
if (__DEV_SCREENSHOTS__) {
  // Register demo state handlers
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === 'DEMO_SET_STATE') {
      setDemoState(msg.state);
      respond({ ok: true });
    }
  });
}
```

---

## Method 2: Webpack Configuration

```javascript
// webpack.config.js
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';
  
  return {
    entry: {
      popup: './src/popup.ts',
      background: './src/background.ts',
      // Conditionally include demo entry
      ...(isDev && { demo: './src/demo.ts' }),
    },
    
    plugins: [
      // Define compile-time constants
      new webpack.DefinePlugin({
        __DEV_SCREENSHOTS__: JSON.stringify(isDev),
      }),
      
      // Copy static files, excluding demo.html in production
      new CopyPlugin({
        patterns: [
          { from: 'src/popup.html', to: 'popup.html' },
          { from: 'src/options.html', to: 'options.html' },
          // Only copy demo.html in dev
          ...(isDev ? [{ from: 'src/demo.html', to: 'demo.html' }] : []),
        ],
      }),
    ],
  };
};
```

---

## Method 3: manifest.json Variants

Keep separate manifests for dev and production:

```
src/
  manifest.json          # Base manifest
  manifest.dev.json      # Dev additions (merged at build time)
```

### manifest.json (production)
```json
{
  "manifest_version": 3,
  "name": "refine.page",
  "version": "1.0.0",
  "action": {
    "default_popup": "popup.html"
  },
  "permissions": ["activeTab", "storage"]
}
```

### manifest.dev.json (dev additions)
```json
{
  "web_accessible_resources": [
    {
      "resources": ["demo.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### Build script to merge:
```javascript
// scripts/build-manifest.js
const base = require('../src/manifest.json');
const dev = require('../src/manifest.dev.json');

const isDev = process.env.NODE_ENV === 'development';
const manifest = isDev ? { ...base, ...dev } : base;

require('fs').writeFileSync(
  'dist/manifest.json', 
  JSON.stringify(manifest, null, 2)
);
```

---

## Method 4: Simple File Copy Script (No Bundler)

```javascript
// scripts/build.js
const fs = require('fs-extra');
const path = require('path');

const isDev = process.argv.includes('--dev');
const srcDir = path.join(__dirname, '../src');
const distDir = path.join(__dirname, '../dist');

// Files to always copy
const alwaysCopy = [
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'background.js',
  'manifest.json',
  'styles/',
  'icons/',
];

// Files only for dev builds
const devOnly = [
  'demo.html',
  'demo.js',
];

// Clean and create dist
fs.removeSync(distDir);
fs.mkdirSync(distDir, { recursive: true });

// Copy standard files
for (const file of alwaysCopy) {
  fs.copySync(path.join(srcDir, file), path.join(distDir, file));
}

// Copy dev-only files if in dev mode
if (isDev) {
  console.log('📦 Including dev-only files for screenshot automation');
  for (const file of devOnly) {
    fs.copySync(path.join(srcDir, file), path.join(distDir, file));
  }
}

console.log(`✅ Built to ${distDir} (${isDev ? 'development' : 'production'})`);
```

---

## TypeScript Declaration (if using __DEV_SCREENSHOTS__)

```typescript
// src/types/globals.d.ts
declare const __DEV_SCREENSHOTS__: boolean;
```

---

## Verification Checklist

Before publishing to Chrome Web Store:

- [ ] Build with `npm run build` (not `build:dev`)
- [ ] Verify `demo.html` is NOT in the `dist/` folder
- [ ] Search for `__DEV_SCREENSHOTS__` in built JS - should not appear
- [ ] Check `manifest.json` doesn't reference `demo.html`
- [ ] Test the production build actually works

```bash
# Quick verification script
#!/bin/bash
if [ -f "dist/demo.html" ]; then
  echo "❌ ERROR: demo.html found in production build!"
  exit 1
fi

if grep -r "__DEV_SCREENSHOTS__" dist/*.js 2>/dev/null; then
  echo "❌ ERROR: Dev flags found in production build!"
  exit 1
fi

echo "✅ Production build is clean"
```
