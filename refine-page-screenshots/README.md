# refine.page Screenshot Automation

Automated screenshot generation for Chrome Web Store listings and website marketing assets.

## Quick Start

```bash
# Install dependencies (in tools/screenshots/)
cd tools/screenshots
npm install

# Build extension in dev mode (includes demo.html)
npm run build:dev

# Capture all screenshots
npm run capture:all -- --extension-path=../../dist
```

## Directory Structure

```
your-extension/
├── src/
│   ├── popup.html
│   ├── background.ts
│   └── demo.html          # DEV-ONLY: Screenshot state renderer
├── dist/                   # Build output
├── screenshots/            # Generated screenshots (gitignored)
├── tools/
│   └── screenshots/
│       ├── capture.mjs     # Puppeteer automation script
│       └── package.json    # Tooling dependencies
└── docs/
    └── BUILD_EXCLUSION.md  # How to exclude dev files from prod
```

## How It Works

1. **Dev build** includes `demo.html` - a page that can render your UI in any pre-configured state
2. **Puppeteer** launches Chrome with your extension loaded
3. **capture.mjs** navigates to `demo.html?state=<state-name>` for each screenshot scenario
4. Screenshots are saved to `/screenshots/`
5. **Production builds** exclude `demo.html` entirely

## Available Scenarios

| Scenario | Dimensions | Description |
|----------|------------|-------------|
| `store-marquee` | 1280×800 | Chrome Web Store main image |
| `store-screenshot-1` | 1280×800 | Store screenshot: list view |
| `store-screenshot-2` | 1280×800 | Store screenshot: annotation |
| `hero-light` | 1440×900 | Website hero (Pastel theme) |
| `hero-dark` | 1440×900 | Website hero (Noir theme) |
| `feature-highlighting` | 800×600 | Highlighting feature callout |
| `feature-evaluation` | 800×600 | Evaluation panel callout |

## Usage

### Capture specific scenario
```bash
npm run capture -- --extension-path=./dist --scenario=hero-light
```

### Capture all store assets
```bash
npm run capture:store -- --extension-path=./dist
```

### Capture all hero images
```bash
npm run capture:hero -- --extension-path=./dist
```

### Capture everything
```bash
npm run capture:all -- --extension-path=./dist
```

## Customizing Scenarios

Edit `tools/screenshots/capture.mjs` to add new scenarios:

```javascript
const SCENARIOS = {
  'my-new-scenario': {
    viewport: { width: 1920, height: 1080 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'my-state-name', { 
        theme: 'noir' 
      });
    },
    filename: 'my-screenshot.png'
  },
};
```

Then add the corresponding state in `demo.html`:

```javascript
const DEMO_STATES = {
  'my-state-name': {
    description: 'Description for reference',
    setup: async (app) => {
      await renderUI(app, {
        // Your UI state configuration
      });
    }
  },
};
```

## Integration with Your UI

The `demo.html` file needs to be customized to actually render your UI components. Look for the `renderUI` function and replace it with your actual rendering logic:

### React Example
```javascript
async function renderUI(container, state) {
  const { createRoot } = await import('react-dom/client');
  const { App } = await import('../src/App');
  
  const root = createRoot(container);
  root.render(<App initialState={state} theme={theme} screenshotMode={true} />);
  
  // Wait for render, then signal ready
  await new Promise(r => setTimeout(r, 100));
  window.__REFINE_SCREENSHOT_READY__ = true;
}
```

### Vanilla JS Example
```javascript
async function renderUI(container, state) {
  const { initApp } = await import('../src/app.js');
  
  await initApp(container, {
    ...state,
    theme,
    screenshotMode: true
  });
  
  window.__REFINE_SCREENSHOT_READY__ = true;
}
```

## Ensuring Dev Code Stays Out of Production

See [BUILD_EXCLUSION.md](./docs/BUILD_EXCLUSION.md) for detailed instructions on:
- Vite configuration
- Webpack configuration
- Manifest variants
- Verification scripts

**Key principle**: The `demo.html` file and any `__DEV_SCREENSHOTS__` code blocks must be completely absent from production builds.

## CI Integration

```yaml
# .github/workflows/screenshots.yml
name: Generate Screenshots

on:
  workflow_dispatch:  # Manual trigger
  push:
    paths:
      - 'src/**'      # Rebuild on UI changes

jobs:
  screenshots:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          npm ci
          cd tools/screenshots && npm ci
      
      - name: Build extension (dev mode)
        run: npm run build:dev
      
      - name: Generate screenshots
        run: |
          cd tools/screenshots
          npm run capture:all -- --extension-path=../../dist
      
      - name: Upload screenshots
        uses: actions/upload-artifact@v4
        with:
          name: screenshots
          path: screenshots/
```

## Troubleshooting

### "Extension not found"
- Ensure you've built with `npm run build:dev` (not production build)
- Check the `--extension-path` points to the directory containing `manifest.json`

### "Ready signal not received"
- Your `renderUI` function needs to set `window.__REFINE_SCREENSHOT_READY__ = true` when done
- Check for JavaScript errors in the extension

### Screenshots look wrong
- Puppeteer runs in headed mode but may render differently than your browser
- Add explicit waits for animations: `await page.waitForTimeout(500)`
- Check that all assets (fonts, images) are bundled in the extension

### Extension popup not captured
- Popups can't be captured directly; render popup content in `demo.html` instead
- Use `demo.html?state=popup-open` to simulate popup appearance
