console.log('Demo script starting...');

// Delay helper function
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ensure ready flag is always set eventually (fallback timeout)
setTimeout(() => {
  if (window.__REFINE_SCREENSHOT_READY__ !== true) {
    console.warn('Ready signal not set after 5 seconds, setting it now');
    window.__REFINE_SCREENSHOT_READY__ = true;
  }
}, 5000);

// Parse URL parameters
const params = new URLSearchParams(window.location.search);
const stateName = params.get('state') || 'default';
const theme = params.get('theme') || 'pastel';

console.log('State:', stateName, 'Theme:', theme);

// Demo state configurations
// Each state sets up the UI in a specific configuration for screenshots
const DEMO_STATES = {
  'default': {
    description: 'Default empty state',
    setup: async (app) => {
      // Render default UI
      await renderUI(app, { view: 'list', snapshots: [] });
    }
  },
  
  'snapshot-list': {
    description: 'List view with sample snapshots',
    setup: async (app) => {
      await renderUI(app, {
        view: 'list',
        snapshots: generateSampleSnapshots(5)
      });
    }
  },
  
  'annotation-in-progress': {
    description: 'Active annotation session',
    setup: async (app) => {
      await renderUI(app, {
        view: 'annotate',
        snapshot: generateSampleSnapshots(1)[0],
        highlights: [
          { id: 1, type: 'element', label: 'Header', color: '#4CAF50' },
          { id: 2, type: 'region', label: 'Main Content', color: '#2196F3' },
        ],
        evaluationPanel: {
          correctness: null,
          pageQuality: null,
          answerPresent: null
        }
      });
    }
  },
  
  'annotation-complete': {
    description: 'Completed annotation with evaluation',
    setup: async (app) => {
      await renderUI(app, {
        view: 'annotate',
        snapshot: generateSampleSnapshots(1)[0],
        highlights: [
          { id: 1, type: 'element', label: 'Answer Location', color: '#4CAF50' },
        ],
        evaluationPanel: {
          correctness: 'correct',
          pageQuality: 'good',
          answerPresent: 'yes'
        }
      });
    }
  },
  
  'hero-demo': {
    description: 'Hero image showcase',
    setup: async (app) => {
      await renderUI(app, {
        view: 'annotate',
        snapshot: generateHeroSnapshot(),
        highlights: [
          { id: 1, type: 'element', label: 'Product Title', color: '#8B5CF6' },
          { id: 2, type: 'region', label: 'Key Information', color: '#EC4899' },
          { id: 3, type: 'text', label: 'Important Detail', color: '#F59E0B' },
        ],
        evaluationPanel: {
          correctness: 'correct',
          pageQuality: 'excellent',
          answerPresent: 'yes'
        }
      });
    }
  },
  
  'highlighting-demo': {
    description: 'Feature showcase: highlighting capabilities',
    setup: async (app) => {
      await renderUI(app, {
        view: 'annotate',
        snapshot: generateSampleSnapshots(1)[0],
        highlights: [
          { id: 1, type: 'element', label: 'Element Selection', color: '#4CAF50' },
          { id: 2, type: 'region', label: 'Region Selection', color: '#2196F3' },
          { id: 3, type: 'text', label: 'Text Selection', color: '#FF9800' },
        ],
        showHighlightTools: true
      });
    }
  },
  
  'evaluation-panel': {
    description: 'Feature showcase: evaluation panel',
    setup: async (app) => {
      await renderUI(app, {
        view: 'annotate',
        snapshot: generateSampleSnapshots(1)[0],
        highlights: [],
        evaluationPanel: {
          correctness: 'partial',
          pageQuality: 'good',
          answerPresent: 'yes'
        },
        focusEvaluationPanel: true
      });
    }
  },
};

// Sample data generators
function generateSampleSnapshots(count) {
  const samples = [
    { title: 'OpenAI Documentation - API Reference', url: 'https://platform.openai.com/docs/api-reference', date: '2024-01-15' },
    { title: 'MDN Web Docs - JavaScript Guide', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide', date: '2024-01-14' },
    { title: 'React Documentation - Hooks', url: 'https://react.dev/reference/react/hooks', date: '2024-01-13' },
    { title: 'Anthropic - Claude API', url: 'https://docs.anthropic.com/claude/reference', date: '2024-01-12' },
    { title: 'GitHub - Actions Documentation', url: 'https://docs.github.com/en/actions', date: '2024-01-11' },
  ];
  
  return samples.slice(0, count).map((s, i) => ({
    id: `snapshot-${i}`,
    ...s,
    thumbnail: generatePlaceholderThumbnail(s.title),
    annotationCount: Math.floor(Math.random() * 5),
    status: ['pending', 'in-progress', 'complete'][Math.floor(Math.random() * 3)]
  }));
}

function generateHeroSnapshot() {
  return {
    id: 'hero-snapshot',
    title: 'Example E-commerce Product Page',
    url: 'https://example.com/products/widget-pro',
    date: '2024-01-15',
    thumbnail: null, // Will use actual demo content
    annotationCount: 3,
    status: 'complete'
  };
}

function generatePlaceholderThumbnail(title) {
  // Return a data URL for a simple placeholder
  return null; // Your actual implementation would generate these
}

/**
 * Main render function - loads the actual viewer UI
 */
async function renderUI(container, state) {
  try {
    // Set up mock snapshot data in chrome.storage FIRST (before viewer loads)
    const mockSnapshot = createMockSnapshot(state);
    await setupMockData(mockSnapshot);
    
    // Load viewer CSS
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = chrome.runtime.getURL('viewer.css');
    document.head.appendChild(cssLink);
    
    // Load viewer HTML structure
    const viewerHtmlResponse = await fetch(chrome.runtime.getURL('viewer.html'));
    const viewerHtmlText = await viewerHtmlResponse.text();
    
    // Extract just the body content (viewer-container and script)
    const bodyMatch = viewerHtmlText.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (!bodyMatch) {
      throw new Error('Could not parse viewer.html body');
    }
    
    // Replace the app container with viewer structure
    container.outerHTML = bodyMatch[1];
    
    // The viewer script tag is now in the DOM, but we need to execute it
    // Wait a moment for DOM to update
    await delay(100);
    
    // Find and execute the viewer script
    const viewerScript = document.querySelector('script[src*="viewer.js"]');
    if (viewerScript) {
      // Remove the old script tag
      viewerScript.remove();
      
      // Create new script and load it
      const script = document.createElement('script');
      script.type = 'module';
      script.src = chrome.runtime.getURL('viewer.js');
      
      script.onload = async () => {
        console.log('Viewer script loaded, waiting for initialization...');
        
        // Wait for viewer to initialize
        await delay(2000);
        
        // Check if snapshots exist in storage and manually trigger load if needed
        const snapshotInfo = await new Promise((resolve) => {
          chrome.storage.local.get(['snapshotIndex'], (result) => {
            const index = result.snapshotIndex || [];
            resolve(index);
          });
        });
        console.log('Snapshots in storage:', snapshotInfo.length, snapshotInfo);
        
        // If we have snapshots but viewer hasn't loaded them, try to trigger manually
        if (snapshotInfo.length > 0) {
          // Wait a bit more for viewer to potentially auto-load
          await delay(2000);
          
          // Check if already loaded
          const pageTitle = document.getElementById('page-title');
          const titleText = pageTitle?.textContent || '';
          const iframe = document.getElementById('preview-frame');
          const iframeSrc = iframe?.src || '';
          
          console.log('Current state - Title:', titleText, 'Iframe:', iframeSrc ? 'has src' : 'no src');
          
          // If not loaded, try to access viewer's loadSnapshot function via window
          // The viewer should have loaded snapshots automatically, but let's check
          if (titleText === 'Loading...' || !iframeSrc) {
            console.log('Snapshot not loaded yet, waiting for viewer to auto-load...');
          }
        }
        
        // Check if snapshots are loaded - wait for viewer to load first snapshot
        let attempts = 0;
        const maxAttempts = 30; // 15 seconds total
        while (attempts < maxAttempts) {
          // Check multiple indicators that snapshot is loaded
          const iframe = document.getElementById('preview-frame');
          const hasIframeSrc = iframe && iframe.src && iframe.src !== '';
          
          const pageTitle = document.getElementById('page-title');
          const titleLoaded = pageTitle && pageTitle.textContent && 
                             pageTitle.textContent !== 'Loading...' && 
                             pageTitle.textContent.trim() !== '';
          
          // Check if snapshot nav has items
          const snapshotNav = document.getElementById('snapshot-nav');
          const hasNavItems = snapshotNav && snapshotNav.children.length > 0;
          
          if (attempts % 5 === 0) { // Log every 2.5 seconds
            console.log(`Attempt ${attempts + 1}/${maxAttempts}: iframe=${hasIframeSrc}, title="${pageTitle?.textContent || 'none'}", nav=${hasNavItems}`);
          }
          
          if (hasIframeSrc && titleLoaded) {
            // Snapshot loaded, wait a bit more for rendering
            console.log('Snapshot loaded! Waiting for final render...');
            await delay(1500);
            window.__REFINE_SCREENSHOT_READY__ = true;
            return;
          }
          
          await delay(500);
          attempts++;
        }
        
        // Timeout - check what we have
        const finalTitle = document.getElementById('page-title')?.textContent || 'unknown';
        const finalIframe = document.getElementById('preview-frame')?.src || 'none';
        const finalNav = document.getElementById('snapshot-nav')?.children.length || 0;
        console.warn(`Viewer snapshot load timeout. Title: "${finalTitle}", Iframe: "${finalIframe}", Nav items: ${finalNav}`);
        console.warn('Proceeding with screenshot anyway...');
        window.__REFINE_SCREENSHOT_READY__ = true;
      };
      
      script.onerror = () => {
        console.error('Failed to load viewer.js');
        window.__REFINE_SCREENSHOT_READY__ = true;
      };
      
      document.body.appendChild(script);
    } else {
      // Fallback: just wait and signal ready
      await delay(2000);
      window.__REFINE_SCREENSHOT_READY__ = true;
    }
    
  } catch (error) {
    console.error('Error in renderUI:', error);
    // Log full error details
    if (error.stack) {
      console.error('Error stack:', error.stack);
    }
    if (error.message) {
      console.error('Error message:', error.message);
    }
    // Still try to show something
    if (container && container.innerHTML !== undefined) {
      container.innerHTML = `
        <div class="error">
          <h2>Error rendering UI</h2>
          <code>${error.message || 'Unknown error'}</code>
        </div>
      `;
    }
    // Always signal ready even on error so screenshots can proceed
    window.__REFINE_SCREENSHOT_READY__ = true;
  }
}

/**
 * Create a mock snapshot based on demo state
 */
function createMockSnapshot(state) {
  const baseHtml = `<!DOCTYPE html><html><head><title>Demo Page</title><style>body{font-family:sans-serif;padding:2rem;max-width:800px;margin:0 auto}h1{color:#333}p{line-height:1.6}</style></head><body><h1>Demo Content</h1><p>This is demo content for screenshot automation. The page contains sample text and structure for testing the annotation interface.</p></body></html>`;
  
  const snapshot = {
    id: 'demo-snapshot-1',
    title: state.snapshot?.title || 'Demo Snapshot',
    url: state.snapshot?.url || 'https://example.com/demo',
    html: baseHtml,
    viewport: { width: 1280, height: 800 },
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questions: state.snapshot?.questions || [{
      id: 'q1',
      query: 'What is this page about?',
      expectedAnswer: '',
      annotationIds: [],
      evaluation: state.evaluationPanel || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    annotations: state.highlights?.map((h, i) => ({
      id: `ann-${i}`,
      type: h.type === 'element' ? 'element' : h.type === 'region' ? 'region' : 'text',
      tool: h.type === 'element' ? 'relevant' : 'answer',
      selector: `body > h1`,
      text: 'Demo Content',
      color: h.color,
      label: h.label,
    })) || [],
    status: 'pending',
    reviewNotes: '',
    tags: [],
  };
  
  return snapshot;
}

/**
 * Set up mock data in chrome.storage
 */
async function setupMockData(snapshot) {
  // Get current snapshot index
  const result = await chrome.storage.local.get(['snapshotIndex']);
  const index = result.snapshotIndex || [];
  
  // Add our demo snapshot to index if not present
  if (!index.includes(snapshot.id)) {
    index.push(snapshot.id);
  }
  
  // Save snapshot and updated index
  await chrome.storage.local.set({
    snapshotIndex: index,
    [`snapshot_${snapshot.id}`]: snapshot,
  });
}

// Initialize
async function init() {
  try {
    const app = document.getElementById('app');
    if (!app) {
      console.error('App container not found');
      window.__REFINE_SCREENSHOT_READY__ = true;
      return;
    }
    
    // Apply theme
    document.documentElement.setAttribute('data-theme', theme);
    
    const stateConfig = DEMO_STATES[stateName];
    
    if (!stateConfig) {
      app.innerHTML = `
        <div class="error">
          <h2>Unknown demo state: ${stateName}</h2>
          <p>Available states:</p>
          <code>${Object.keys(DEMO_STATES).join(', ')}</code>
        </div>
      `;
      window.__REFINE_SCREENSHOT_READY__ = true;
      return;
    }
    
    try {
      await stateConfig.setup(app);
    } catch (error) {
      console.error('Error in state setup:', error);
      app.innerHTML = `
        <div class="error">
          <h2>Error loading demo state</h2>
          <code>${error.message}</code>
          <pre>${error.stack}</pre>
        </div>
      `;
      window.__REFINE_SCREENSHOT_READY__ = true;
    }
  } catch (error) {
    console.error('Fatal error in init:', error);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML = `
        <div class="error">
          <h2>Fatal initialization error</h2>
          <code>${error.message}</code>
        </div>
      `;
    }
    window.__REFINE_SCREENSHOT_READY__ = true;
  }
}

// Ensure init runs and ready signal is always set
init().catch(error => {
  console.error('Unhandled error:', error);
  window.__REFINE_SCREENSHOT_READY__ = true;
});

