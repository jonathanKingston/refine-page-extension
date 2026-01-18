#!/usr/bin/env node
/**
 * Screenshot automation for refine.page marketing assets
 * 
 * This script loads the extension in a real Chrome instance and captures
 * screenshots of various states for store listings and website assets.
 * 
 * Usage:
 *   node scripts/screenshots/capture.mjs --extension-path=./dist
 *   node scripts/screenshots/capture.mjs --extension-path=./dist --scenario=all
 *   node scripts/screenshots/capture.mjs --extension-path=./dist --scenario=chrome-store-screenshot-1-list
 */

import puppeteer from 'puppeteer';
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Docker environment detection
const isDocker = process.env.DOCKER === '1' || existsSync('/.dockerenv');
const PUPPETEER_EXECUTABLE_PATH = isDocker ? '/usr/bin/chromium' : undefined;

if (isDocker) {
  console.log('🐳 Running in Docker environment - configuring for Xvfb');
  console.log(`🔧 Using Chrome at: ${PUPPETEER_EXECUTABLE_PATH}`);
}
// Output to screenshots directory at project root
const OUTPUT_DIR = path.join(__dirname, '../../screenshots');
const SNAPSHOTS_DIR = path.join(__dirname, '../../snapshots');

// Parse CLI arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  acc[key] = value ?? true;
  return acc;
}, {});

const EXTENSION_PATH = args['extension-path'] || './dist';
const SCENARIO = args['scenario'] || 'all';
const PAGES_CONFIG = args['pages-config']; // Optional: path to pages.json config file
const CAPTURE_PAGES = args['capture-pages'] !== undefined; // Flag to capture pages first

// Preferred snapshot order for consistent screenshots (by URL pattern)
const SNAPSHOT_ORDER = [
  'Pasty',           // Pasty - Wikipedia first
  'David_Bowie',     // David Bowie - Wikipedia  
  'Converge',        // Converge (band) - Wikipedia
  'Reinforcement',   // RLHF - Wikipedia
  'example.com',     // Example.com
  'openai.com',      // OpenAI API Reference
];

// Full-scale capture viewport (all screenshots captured at this size, then scaled)
const CAPTURE_VIEWPORT = { width: 1600, height: 1000 };

// Screenshot configurations for different marketing contexts
// All captured at CAPTURE_VIEWPORT, then scaled to outputSize if specified
const SCENARIOS = {
  // Chrome Web Store Screenshots (1280x800)
  'chrome-store-screenshot-1-list': {
    viewport: CAPTURE_VIEWPORT,
    outputSize: { width: 1280, height: 800 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'snapshot-list');
    },
    filename: 'chrome-store-screenshot-1-list-1280x800.png'
  },
  
  'chrome-store-screenshot-2-annotations': {
    viewport: CAPTURE_VIEWPORT,
    outputSize: { width: 1280, height: 800 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'pasty-demo');
    },
    filename: 'chrome-store-screenshot-2-annotations-1280x800.png'
  },
  
  'chrome-store-screenshot-3-dark': {
    viewport: CAPTURE_VIEWPORT,
    outputSize: { width: 1280, height: 800 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'pasty-demo');
      // Enable dark mode
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'noir';
      });
      await delay(500);
    },
    filename: 'chrome-store-screenshot-3-dark-1280x800.png'
  },
  
  'chrome-store-screenshot-4-autodetect': {
    viewport: CAPTURE_VIEWPORT,
    outputSize: { width: 1280, height: 800 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'david-bowie-autodetect');
    },
    filename: 'chrome-store-screenshot-4-autodetect-1280x800.png'
  },

  // Base capture for pasty-demo (used to derive multiple outputs)
  '_base-pasty-demo': {
    viewport: CAPTURE_VIEWPORT,
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'pasty-demo');
    },
    filename: '_base-pasty-demo.png', // Internal, will be deleted
    isBase: true
  },
  
  // Chrome Web Store Promo Tiles (derived from base)
  'chrome-store-marquee-tile': {
    baseCapture: '_base-pasty-demo',
    outputSize: { width: 1400, height: 560 },
    filename: 'chrome-store-marquee-tile-1400x560.png'
  },
  
  'chrome-store-small-tile': {
    baseCapture: '_base-pasty-demo',
    outputSize: { width: 440, height: 280 }, // Base size (Chrome Web Store requirement)
    filename: 'chrome-store-small-tile-440x280.png'
  },

  // Website hero images (derived from base)
  'homepage-hero-light': {
    baseCapture: '_base-pasty-demo',
    filename: 'homepage-hero-light.png'
  },

  // Feature callouts (derived from base)
  'feature-text-highlighting': {
    baseCapture: '_base-pasty-demo',
    outputSize: { width: 800, height: 600 },
    filename: 'feature-text-highlighting-800x600.png'
  },

  'feature-evaluation-panel': {
    baseCapture: '_base-pasty-demo',
    outputSize: { width: 800, height: 600 },
    filename: 'feature-evaluation-panel-800x600.png'
  },

  // Unique captures (require separate setup)
  'homepage-hero-dark': {
    viewport: CAPTURE_VIEWPORT,
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'pasty-demo');
      // Enable dark mode
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'noir';
      });
      await delay(500);
    },
    filename: 'homepage-hero-dark.png'
  },
  
  'feature-auto-detect': {
    viewport: CAPTURE_VIEWPORT,
    outputSize: { width: 800, height: 600 },
    setup: async (page, extensionId) => {
      await loadDemoState(page, extensionId, 'pasty-demo');
      // Click the Auto-detect button
      const autoDetectBtn = await page.$('#auto-detect-btn');
      if (autoDetectBtn) {
        await autoDetectBtn.click();
        await delay(2000); // Wait for elements to be detected
      }
    },
    filename: 'feature-auto-detect-800x600.png'
  },
};

/**
 * Simple delay helper (replacement for deprecated waitForTimeout)
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load a specific demo state in the extension
 * This communicates with the extension via a dev-only message handler
 */
async function loadDemoState(page, extensionId, stateName, options = {}) {
  // All states use viewer.html directly (uses actual extension codebase)
  const viewerUrl = `chrome-extension://${extensionId}/viewer.html`;
  console.log(`  🌐 Navigating to: ${viewerUrl}`);
  await page.goto(viewerUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  
  // Wait for extension API to be available and actually functional
  await page.waitForFunction(() => {
    try {
      return typeof chrome !== 'undefined' && 
             typeof chrome.storage !== 'undefined' &&
             typeof chrome.storage.local !== 'undefined' &&
             typeof chrome.storage.local.get === 'function';
    } catch (e) {
      return false;
    }
  }, { timeout: 15000 }).catch(() => {
    console.warn(`  ⚠️  Extension API may not be ready`);
  });
  
  // Try to access storage to ensure it's ready
  await page.evaluate(async () => {
    try {
      await chrome.storage.local.get(['snapshotIndex']);
    } catch (e) {
      // Storage might not be ready yet
    }
  });
  
  await delay(2000);
  
  // Check if snapshots exist in storage - retry with delays
  // First, trigger a storage read to force sync with background script
  await page.evaluate(async () => {
    try {
      // Force a storage read to sync with background
      await chrome.storage.local.get(null);
    } catch (e) {
      // Ignore errors, storage might not be ready
    }
  });
  await delay(1000);
  
  let snapshotInfo = { count: 0, index: [] };
  let retries = 10;
  while (retries > 0 && snapshotInfo.count === 0) {
    snapshotInfo = await page.evaluate(async () => {
      try {
        // Ensure chrome.storage is available
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
          return { count: 0, index: [], error: 'chrome.storage not available', hasStorage: false };
        }
        
        // Try to get snapshotIndex
      const result = await chrome.storage.local.get(['snapshotIndex']);
        const index = result.snapshotIndex || [];
        const count = Array.isArray(index) ? index.length : 0;
        
        // If we have an index, verify at least one snapshot actually exists
        if (count > 0) {
          const testKey = `snapshot_${index[0]}`;
          const testResult = await chrome.storage.local.get([testKey]);
          if (!testResult[testKey]) {
            // Index exists but snapshot doesn't - might still be syncing
            return { count: 0, index: [], error: 'Snapshot data not yet synced', hasStorage: true };
          }
        }
        
      return {
        count,
          index,
          hasStorage: true
      };
    } catch (error) {
      return { count: 0, index: [], error: error.message, hasStorage: false };
    }
  });
    
    if (snapshotInfo.count === 0 && retries > 1) {
      const errorMsg = snapshotInfo.error ? ` (${snapshotInfo.error})` : '';
      console.log(`  ⏳ Waiting for snapshots in storage...${errorMsg} (${retries - 1} retries left)`);
      await delay(2000);
    }
    retries--;
  }
  
  if (snapshotInfo.count === 0) {
    console.warn(`  ⚠️  No snapshots found in storage after retries. Snapshots should have been imported before scenarios run.`);
    console.warn(`  Check the import output above for errors.`);
    await page.waitForSelector('#snapshot-nav, #page-title', { timeout: 5000 }).catch(() => {});
    return;
  }
  
  console.log(`  📦 Found ${snapshotInfo.count} snapshots in storage`);
  
  // Wait for viewer to initialize and load snapshots
  try {
    await page.waitForFunction(() => {
      return document.readyState === 'complete' && typeof window !== 'undefined';
    }, { timeout: 10000 });
    
    await delay(2000);
    
    // Wait for snapshots to load in UI - more robust check
    // For list view, we don't need iframe; for others we do
    const needsIframe = stateName !== 'snapshot-list';
    
    await page.waitForFunction((needsIframe) => {
      const iframe = document.getElementById('preview-frame');
      const title = document.getElementById('page-title');
      const nav = document.getElementById('snapshot-nav');
      
      // Nav must have items and not be in loading state
      const navHasItems = nav && nav.children.length > 0 &&
                         !nav.textContent?.includes('No snapshots') &&
                         !nav.textContent?.includes('Loading');
      
      // Iframe must be loaded (for states that need it)
      const iframeLoaded = !needsIframe || (iframe && iframe.src && 
                          iframe.src.includes('iframe.html') && 
                          iframe.src !== '');
      
      // Title must be set and not loading
      const titleSet = title && 
                      title.textContent && 
                      title.textContent !== 'Loading...' &&
                      title.textContent.trim() !== '';
      
      // All conditions must be met
      return navHasItems && iframeLoaded && titleSet;
    }, { timeout: 30000, polling: 200 }, needsIframe);
    
    // Additional wait to ensure everything is stable
    await delay(1500);
    
    console.log(`  ✓ Snapshots loaded successfully`);
    await delay(500);
    
    // Handle pasty-demo state - select Pasty snapshot and set up annotations
    if (stateName === 'pasty-demo') {
      await setupPastyDemoState(page);
    }
    
    // Handle david-bowie-autodetect state - select David Bowie snapshot and enable auto-detect
    if (stateName === 'david-bowie-autodetect') {
      await setupDavidBowieAutodetect(page);
    }
    
    // For snapshot-list state, ensure the list is fully rendered
    if (stateName === 'snapshot-list') {
      // Wait for nav items to be fully rendered and visible
      await page.waitForFunction(() => {
        const nav = document.getElementById('snapshot-nav');
        const items = nav?.querySelectorAll('li');
        return nav && items && items.length > 0 && 
               Array.from(items).every(item => item.offsetHeight > 0);
      }, { timeout: 10000 }).catch(() => {});
      await delay(1000);
      console.log(`  ✓ List view ready`);
    }
    
    // Final wait to ensure everything is settled
    await delay(500);
    
  } catch (error) {
    const state = await page.evaluate(() => {
      const iframe = document.getElementById('preview-frame');
      const title = document.getElementById('page-title');
      const nav = document.getElementById('snapshot-nav');
      return {
        iframe: iframe?.src || 'none',
        title: title?.textContent || 'none',
        navItems: nav?.children.length || 0,
        navText: nav?.textContent?.substring(0, 50) || 'none',
        readyState: document.readyState,
      };
    });
    console.warn(`  ⚠️  Snapshot loading timeout for ${stateName}`);
    console.warn(`    iframe: ${state.iframe.substring(0, 80)}`);
    console.warn(`    title: "${state.title}"`);
    console.warn(`    nav items: ${state.navItems}`);
  }
}

/**
 * Wait for iframe content to be fully loaded
 */
async function waitForIframeContent(page, timeout = 15000) {
  try {
    await page.waitForFunction(() => {
      const iframe = document.getElementById('preview-frame');
      if (!iframe || !iframe.contentDocument) return false;
      
      try {
        const doc = iframe.contentDocument;
        // Check if document has actual content (not just loading)
        const hasContent = doc.body && 
                           doc.body.children.length > 0 &&
                           doc.body.textContent.trim().length > 50;
        
        // Check if title is set (not "Loading...")
        const title = document.getElementById('page-title');
        const titleReady = title && 
                          title.textContent && 
                          title.textContent !== 'Loading...' &&
                          title.textContent.trim() !== '';
        
        return hasContent && titleReady;
      } catch (e) {
        // Cross-origin, check if iframe src is set
        return iframe.src && iframe.src.includes('iframe.html');
      }
    }, { timeout, polling: 200 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Set up the Pasty demo state with question and annotations
 */
async function setupPastyDemoState(page) {
  console.log(`  🎨 Setting up Pasty demo state...`);
  
  // Find and select the Pasty snapshot, add question and annotations
  const result = await page.evaluate(async () => {
    // Find Pasty snapshot
    const indexResult = await chrome.storage.local.get(['snapshotIndex']);
    const index = indexResult.snapshotIndex || [];
    
    let pastyId = null;
    for (const id of index) {
      const snapshotResult = await chrome.storage.local.get([`snapshot_${id}`]);
      const snapshot = snapshotResult[`snapshot_${id}`];
      if (snapshot && (snapshot.title?.includes('Pasty') || snapshot.url?.includes('Pasty'))) {
        pastyId = id;
        break;
      }
    }
    
    if (!pastyId) {
      return { error: 'Pasty snapshot not found' };
    }
    
    // Get the snapshot
    const snapshotResult = await chrome.storage.local.get([`snapshot_${pastyId}`]);
    const snapshot = snapshotResult[`snapshot_${pastyId}`];
    
    if (!snapshot) {
      return { error: 'Could not load Pasty snapshot' };
    }
    
    // Create demo question (annotations will be created via UI interaction)
    const now = new Date().toISOString();
    const questionId = `q_demo_${Date.now()}`;
    
    // Question: What food is this?
    const question = {
      id: questionId,
      query: 'What food is this?',
      expectedAnswer: '',
      annotationIds: [],  // Will be populated when we create annotations via UI
      evaluation: {},
      createdAt: now,
      updatedAt: now,
    };
    
    // Update snapshot with question only (no pre-made annotations)
    snapshot.questions = [question];
    snapshot.annotations = { text: [], region: [] };
    snapshot.updatedAt = now;
    
    // Save back to storage
    await chrome.storage.local.set({ [`snapshot_${pastyId}`]: snapshot });
    
    return { success: true, pastyId, questionId };
  });
  
  if (result.error) {
    console.warn(`  ⚠️  ${result.error}`);
    return;
  }
  
  console.log(`  ✓ Demo data created for Pasty snapshot`);
  
  // Reload the page to pick up the changes
  await page.reload({ waitUntil: 'networkidle0' });
  
  // Listen to console messages from the page for debugging (disabled by default)
  if (process.env.DEBUG_SCREENSHOTS) {
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('Iframe') || text.includes('annotation') || text.includes('sync') || text.includes('LOAD_')) {
        console.log(`  [PAGE] ${text}`);
      }
    });
  }
  
  // Wait for snapshots to load in the UI
  const navLoaded = await page.waitForFunction(() => {
    const nav = document.getElementById('snapshot-nav');
    const items = nav?.querySelectorAll('li');
    return nav && items && items.length > 0;
  }, { timeout: 15000 }).then(() => true).catch(() => false);
  
  if (!navLoaded) {
    console.warn(`  ⚠️  Snapshot nav didn't load after reload`);
    // Debug the state
    const navState = await page.evaluate(() => {
      const nav = document.getElementById('snapshot-nav');
      return {
        exists: !!nav,
        html: nav?.innerHTML?.substring(0, 200) || 'empty',
        childCount: nav?.children?.length || 0
      };
    });
    console.warn(`  Nav state: exists=${navState.exists}, children=${navState.childCount}`);
  }
  
  await delay(1000);
  
  // Click on the Pasty snapshot in the sidebar to select it
  const pastyClicked = await page.evaluate(() => {
    // Nav items are <li> elements with data-id attribute
    const navItems = document.querySelectorAll('#snapshot-nav li');
    const titles = [];
    for (const item of navItems) {
      titles.push(item.textContent?.trim().substring(0, 30));
      if (item.textContent?.includes('Pasty')) {
        item.click();
        return { clicked: true, titles };
      }
    }
    return { clicked: false, titles };
  });
  
  if (pastyClicked.clicked) {
    console.log(`  ✓ Clicked Pasty in sidebar`);
    
    // Wait for iframe content to actually load
    const iframeLoaded = await waitForIframeContent(page, 20000);
    if (iframeLoaded) {
      console.log(`  ✓ Iframe content loaded`);
    } else {
      console.warn(`  ⚠️  Iframe content may not have loaded fully`);
    }
    
    // Additional wait for questions to render
    await delay(1000);
  } else {
    console.warn(`  ⚠️  Could not find Pasty. Available: ${pastyClicked.titles.join(', ')}`);
    await delay(2000);
  }
  
  // Debug: check what questions exist
  const questionDebug = await page.evaluate(() => {
    const questionList = document.getElementById('questions-list');
    const items = questionList?.querySelectorAll('.question-item');
    return {
      listExists: !!questionList,
      itemCount: items?.length || 0,
      html: questionList?.innerHTML?.substring(0, 200) || 'empty'
    };
  });
  console.log(`  📋 Questions: list=${questionDebug.listExists}, count=${questionDebug.itemCount}`);
  
  // Select the first question to trigger annotation sync
  const questionClicked = await page.evaluate(() => {
    const questionItem = document.querySelector('#questions-list .question-item');
    if (questionItem) {
      questionItem.click();
      return true;
    }
    return false;
  });
  
  if (questionClicked) {
    console.log(`  ✓ Question selected`);
    await delay(2000);
    
    // Create real annotations by selecting text and clicking buttons
    console.log(`  🖱️  Creating annotations via text selection...`);
    
    // Get iframe position
    const iframe = await page.$('#preview-frame');
    if (iframe) {
      const iframeBox = await iframe.boundingBox();
      if (iframeBox) {
        console.log(`  📐 Iframe bounds: ${Math.round(iframeBox.x)},${Math.round(iframeBox.y)} - ${Math.round(iframeBox.width)}x${Math.round(iframeBox.height)}`);
        
        // Triple-click on title to select "Pasty" - this selects the whole line
        const relevantBtn = await page.$('button[data-tool="relevant"]');
        if (relevantBtn) {
          await relevantBtn.click();
          await delay(300);
        }
        
        // ANNOTATION 1: Select "Pasty" title (relevant)
        const titlePos = await page.evaluate(() => {
          const iframe = document.getElementById('preview-frame');
          if (!iframe || !iframe.contentDocument) return null;
          const title = iframe.contentDocument.querySelector('h1, .mw-page-title-main, .firstHeading');
          if (!title) return null;
          const rect = title.getBoundingClientRect();
          const iframeRect = iframe.getBoundingClientRect();
          return {
            x: iframeRect.x + rect.x + rect.width / 2,
            y: iframeRect.y + rect.y + rect.height / 2
          };
        });
        
        if (titlePos) {
          await page.mouse.click(titlePos.x, titlePos.y, { clickCount: 3 });
          await delay(500);
        }
        
        let selection = await page.evaluate(() => {
          const iframe = document.getElementById('preview-frame');
          try {
            return iframe?.contentWindow?.getSelection()?.toString() || '';
          } catch(e) { return ''; }
        });
        
        if (selection) {
          console.log(`  ✓ Annotation 1 (relevant): "${selection.substring(0, 30).trim()}"`);
          await delay(1500);
        }
        
        // Clear selection
        await page.mouse.click(iframeBox.x + 50, iframeBox.y + 50);
        await delay(300);
        
        // ANNOTATION 2: Select first paragraph (relevant)
        // Find the first paragraph of the article body
        const paraPos = await page.evaluate(() => {
          const iframe = document.getElementById('preview-frame');
          if (!iframe || !iframe.contentDocument) return null;
          // Find the first paragraph after "From Wikipedia" that starts with "A pasty"
          const paragraphs = iframe.contentDocument.querySelectorAll('p');
          for (const p of paragraphs) {
            if (p.textContent?.includes('A pasty') && p.textContent?.includes('pastry')) {
              const rect = p.getBoundingClientRect();
              const iframeRect = iframe.getBoundingClientRect();
              return {
                x: iframeRect.x + rect.x + 10,
                y: iframeRect.y + rect.y + rect.height / 2
              };
            }
          }
          return null;
        });
        
        if (paraPos) {
          // Triple-click to select the paragraph
          await page.mouse.click(paraPos.x, paraPos.y, { clickCount: 3 });
          await delay(500);
          
          selection = await page.evaluate(() => {
            const iframe = document.getElementById('preview-frame');
            try {
              return iframe?.contentWindow?.getSelection()?.toString() || '';
            } catch(e) { return ''; }
          });
          
          if (selection) {
            console.log(`  ✓ Annotation 2 (relevant): "${selection.substring(0, 40).trim()}..."`);
            await delay(1500);
          }
        }
        
        // Clear selection
        await page.mouse.click(iframeBox.x + 50, iframeBox.y + 50);
        await delay(300);
        
        // ANNOTATION 3: Select "Course Main, snack" from infobox (answer)
        const answerBtn = await page.$('button[data-tool="answer"]');
        if (answerBtn) {
          await answerBtn.click();
          await delay(300);
        }
        
        // Find "Course" row in infobox and select its value
        const coursePos = await page.evaluate(() => {
          const iframe = document.getElementById('preview-frame');
          if (!iframe || !iframe.contentDocument) return null;
          // Find the infobox row that contains "Course"
          const rows = iframe.contentDocument.querySelectorAll('.infobox tr, table.infobox tr');
          for (const row of rows) {
            const header = row.querySelector('th');
            if (header?.textContent?.includes('Course')) {
              const value = row.querySelector('td');
              if (value) {
                const rect = value.getBoundingClientRect();
                const iframeRect = iframe.getBoundingClientRect();
                return {
                  x: iframeRect.x + rect.x + rect.width / 2,
                  y: iframeRect.y + rect.y + rect.height / 2
                };
              }
            }
          }
          return null;
        });
        
        if (coursePos) {
          await page.mouse.click(coursePos.x, coursePos.y, { clickCount: 3 });
          await delay(500);
          
          selection = await page.evaluate(() => {
            const iframe = document.getElementById('preview-frame');
            try {
              return iframe?.contentWindow?.getSelection()?.toString() || '';
            } catch(e) { return ''; }
          });
          
          if (selection) {
            console.log(`  ✓ Annotation 3 (answer): "${selection.substring(0, 30).trim()}"`);
            await delay(1500);
          }
        }
        
        selection = await page.evaluate(() => {
          const iframe = document.getElementById('preview-frame');
          try {
            return iframe?.contentWindow?.getSelection()?.toString() || '';
          } catch(e) { return ''; }
        });
        
        if (selection) {
          console.log(`  ✓ Selected (answer): "${selection.substring(0, 40).trim()}"`);
          await delay(1500);
        }
        
        // Clear selection
        await page.mouse.click(iframeBox.x + 50, iframeBox.y + 50);
        await delay(500);
      }
    }
    
    // Verify annotations are showing in sidebar
    const annotationInfo = await page.evaluate(() => {
      const listItems = document.querySelectorAll('#annotation-list .annotation-item');
      return {
        count: listItems.length,
        hasAnnotations: listItems.length > 0
      };
    });
    
    if (annotationInfo.hasAnnotations) {
      console.log(`  ✓ ${annotationInfo.count} annotations created`);
    } else {
      console.warn(`  ⚠️  No annotations visible in sidebar`);
    }
  } else {
    console.warn(`  ⚠️  Could not click question`);
  }
  
  // Close any open Wikipedia panels (like "Appearance" dropdown)
  await page.evaluate(() => {
    const iframe = document.getElementById('preview-frame');
    if (iframe && iframe.contentWindow) {
      try {
        // Close Wikipedia Appearance panel if open
        const appearancePanel = iframe.contentDocument?.querySelector('.vector-settings, .vector-dropdown-content, .oo-ui-popupWidget');
        if (appearancePanel) {
          appearancePanel.style.display = 'none';
        }
        // Click elsewhere to close any open dropdowns
        iframe.contentDocument?.body?.click();
      } catch (e) {
        // Cross-origin, ignore
      }
    }
  });
  
  await delay(500);
  console.log(`  ✓ Pasty demo state ready`);
}

/**
 * Set up David Bowie snapshot with auto-detect enabled
 */
async function setupDavidBowieAutodetect(page) {
  console.log(`  🎨 Setting up David Bowie with auto-detect...`);
  
  // Wait for snapshots to load
  await page.waitForFunction(() => {
    const nav = document.getElementById('snapshot-nav');
    const items = nav?.querySelectorAll('li');
    return nav && items && items.length > 0;
  }, { timeout: 15000 }).catch(() => {});
  
  await delay(1000);
  
  // Click on the David Bowie snapshot in the sidebar
  const bowieClicked = await page.evaluate(() => {
    const navItems = document.querySelectorAll('#snapshot-nav li');
    for (const item of navItems) {
      if (item.textContent?.includes('David Bowie') || item.textContent?.includes('Bowie')) {
        item.click();
        return { clicked: true };
      }
    }
    return { clicked: false };
  });
  
  if (bowieClicked.clicked) {
    console.log(`  ✓ Clicked David Bowie in sidebar`);
    
    // Wait for iframe content to actually load before enabling auto-detect
    const iframeLoaded = await waitForIframeContent(page, 20000);
    if (iframeLoaded) {
      console.log(`  ✓ Iframe content loaded`);
    } else {
      console.warn(`  ⚠️  Iframe content may not have loaded fully`);
    }
    
    // Additional wait to ensure page is stable
    await delay(2000);
    
    // Click the Auto-detect button
    const autoDetectBtn = await page.$('#auto-detect-btn');
    if (autoDetectBtn) {
      await autoDetectBtn.click();
      console.log(`  ✓ Enabled Auto-detect`);
      await delay(3000); // Wait for elements to be detected and highlighted
    } else {
      console.warn(`  ⚠️  Auto-detect button not found`);
    }
  } else {
    console.warn(`  ⚠️  Could not find David Bowie snapshot`);
    await delay(2000);
  }
  
  console.log(`  ✓ David Bowie auto-detect state ready`);
}

/**
 * Get the extension ID after loading
 */
async function getExtensionId(browser, extensionPath) {
  // Method 1: Try to find service worker target (faster polling)
  for (let i = 0; i < 5; i++) {
  const targets = await browser.targets();
  const extensionTarget = targets.find(
    target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
  );
  
    if (extensionTarget) {
      const url = new URL(extensionTarget.url());
      console.log(`  ✓ Found extension ID via service worker: ${url.hostname}`);
      return url.hostname;
    }
    
    await delay(200);
  }
  
  // Method 2: Try Chrome DevTools Protocol to get extension info
  try {
    const pages = await browser.pages();
    if (pages.length > 0) {
      const client = await pages[0].target().createCDPSession();
      const response = await client.send('Target.getTargets');
      const extensionTarget = response.targetInfos?.find(ext => 
        ext.type === 'service_worker' && ext.url?.startsWith('chrome-extension://')
      );
      if (extensionTarget) {
        const url = new URL(extensionTarget.url);
        console.log(`  ✓ Found extension ID via CDP: ${url.hostname}`);
  return url.hostname;
      }
    }
  } catch (error) {
    console.warn('  CDP method failed:', error.message);
  }
  
  // Method 3: Try navigating to a known extension page and extract ID from URL
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    
    // Try to get extension ID by attempting to access extension resources
    const extensionId = await page.evaluate(async () => {
      // Try chrome.runtime.id if available
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        return chrome.runtime.id;
      }
      return null;
    });
    
    await page.close();
    
    if (extensionId) {
      console.log(`  ✓ Found extension ID via page context: ${extensionId}`);
      return extensionId;
    }
  } catch (error) {
    console.warn('  Page context method failed:', error.message);
  }
  
  // Method 4: Try to access extension pages directly by scanning common IDs
  // This is a fallback - we'll try accessing viewer.html and see what works
  try {
    const testPage = await browser.newPage();
    // Try accessing chrome://extensions to see loaded extensions
    await testPage.goto('chrome://extensions', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await delay(2000);
    
    // Try to extract extension IDs from the extensions page
    const extensionIds = await testPage.evaluate(() => {
      // Chrome extensions page has extension cards with IDs
      const cards = document.querySelectorAll('extensions-item');
      const ids = [];
      cards.forEach(card => {
        const id = card.getAttribute('id');
        if (id) ids.push(id);
      });
      return ids;
    }).catch(() => []);
    
    if (extensionIds.length > 0) {
      // Try each ID to see which one has viewer.html
      for (const id of extensionIds) {
        try {
          const testUrl = `chrome-extension://${id}/viewer.html`;
          const response = await testPage.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 3000 });
          if (response && response.ok()) {
            console.log(`  ✓ Found extension ID via extensions page: ${id}`);
            await testPage.close();
            return id;
          }
        } catch (error) {
          // Try next ID
        }
      }
    }
    await testPage.close();
  } catch (error) {
    console.warn('  Extensions page method failed:', error.message);
  }
  
  // Method 5: List all targets and look for extension pages with our files
  try {
    const targets = await browser.targets();
    console.log('  Scanning targets for extension...');
    const extensionIds = new Set();
    
    // Collect all extension IDs from targets
    for (const target of targets) {
      const url = target.url();
      if (url.startsWith('chrome-extension://')) {
        const urlObj = new URL(url);
        extensionIds.add(urlObj.hostname);
      }
    }
    
    // Try each extension ID to see which one has viewer.html
    for (const id of extensionIds) {
      try {
        const testPage = await browser.newPage();
        const testUrl = `chrome-extension://${id}/viewer.html`;
        const response = await testPage.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 3000 });
        if (response && response.ok()) {
          const pageContent = await testPage.evaluate(() => document.title || '');
          // Check if it's our viewer (should have specific content)
          if (pageContent || response.url() === testUrl) {
            console.log(`  ✓ Found extension ID via target scan: ${id}`);
            await testPage.close();
            return id;
          }
        }
        await testPage.close();
      } catch (error) {
        // Not this one, try next
      }
    }
    
    // If we found extension IDs but none worked, return the first one anyway
    if (extensionIds.size > 0) {
      const firstId = Array.from(extensionIds)[0];
      console.log(`  ⚠️  Using first found extension ID (may not be correct): ${firstId}`);
      return firstId;
    }
  } catch (error) {
    console.warn('  Target scan failed:', error.message);
  }
  
  throw new Error('Could not find extension service worker. Is the extension built correctly? Make sure you ran: npm run build:dev');
}

/**
 * Import snapshots from snapshots/ directory into extension storage
 */
async function importSnapshotsIntoStorage(page, extensionId) {
  console.log(`  📂 Checking snapshots directory: ${SNAPSHOTS_DIR}`);
  
  if (!existsSync(SNAPSHOTS_DIR)) {
    console.log('  📁 No snapshots directory found, skipping import');
    return { imported: 0, total: 0 };
  }
  
  try {
    const files = await readdir(SNAPSHOTS_DIR);
    console.log(`  📂 Found ${files.length} files in snapshots directory`);
    const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'index.json' && f !== 'pages.json' && f !== 'pages.json.example');
    
    if (jsonFiles.length === 0) {
      console.log('  📁 No snapshot files found, skipping import');
      console.log(`  📂 Available files: ${files.join(', ')}`);
      return { imported: 0, total: 0 };
    }
    
    console.log(`  📥 Importing ${jsonFiles.length} snapshots...`);
    console.log(`  📂 Snapshot files: ${jsonFiles.join(', ')}`);
    
    // Load all snapshots from files
    const snapshots = [];
    for (const jsonFile of jsonFiles) {
      try {
        const jsonPath = path.join(SNAPSHOTS_DIR, jsonFile);
        const metadata = JSON.parse(await readFile(jsonPath, 'utf8'));
        
        if (!metadata.htmlFile && !metadata.url) {
          continue;
        }
        
        const htmlFile = metadata.htmlFile || jsonFile.replace('.json', '.html');
        const htmlPath = path.join(SNAPSHOTS_DIR, htmlFile);
        
        if (!existsSync(htmlPath)) {
          continue;
        }
        
        const html = await readFile(htmlPath, 'utf8');
        // Make HTML inert (remove scripts, disable links) and clean up Wikipedia UI
        const inertHtml = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<a\s+([^>]*href\s*=\s*["'][^"']*["'][^>]*)>/gi, (match, attrs) => {
            return `<a ${attrs} onclick="return false;" style="pointer-events: none; cursor: default;">`;
          })
          .replace(/<form\b[^>]*>/gi, (match) => {
            return match.replace(/>$/, ' onsubmit="return false;">');
          })
          // Hide Wikipedia settings/appearance panels
          .replace(/<\/head>/i, `<style>
            .vector-settings, .vector-dropdown-content, .oo-ui-popupWidget,
            .vector-page-toolbar-container .vector-dropdown-content,
            .client-js .vector-menu-content, .cdx-menu, .mw-portlet-vector-page-tools-dropdown .vector-menu-content,
            #vector-appearance { display: none !important; }
            .mw-body { padding-top: 0 !important; }
          </style></head>`);
        
        // Generate snapshot ID
        function generateSnapshotId(url) {
          try {
            const urlObj = new URL(url);
            return `snapshot-${urlObj.hostname.replace(/\./g, '-')}-${urlObj.pathname.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').substring(0, 50)}-${Date.now()}`;
          } catch {
            return `snapshot-${Date.now()}-${Math.random().toString(36).substring(7)}`;
          }
        }
        
        const snapshot = {
          id: generateSnapshotId(metadata.url),
          url: metadata.url,
          title: metadata.title || 'Untitled',
          html: inertHtml,
          viewport: metadata.viewport || { width: 1280, height: 800 },
          annotations: { text: [], region: [] },
          questions: [],
          status: 'pending',
          tags: [],
          capturedAt: metadata.capturedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        
        snapshots.push(snapshot);
      } catch (error) {
        console.warn(`  ⚠️  Error loading ${jsonFile}:`, error.message);
      }
    }
    
    if (snapshots.length === 0) {
      console.log('  📁 No valid snapshots to import');
      return { imported: 0, total: 0 };
    }
    
    // Sort snapshots by preferred order for consistent screenshots
    snapshots.sort((a, b) => {
      const getOrderIndex = (snapshot) => {
        const titleOrUrl = (snapshot.title + ' ' + snapshot.url).toLowerCase();
        for (let i = 0; i < SNAPSHOT_ORDER.length; i++) {
          if (titleOrUrl.includes(SNAPSHOT_ORDER[i].toLowerCase())) {
            return i;
          }
        }
        return SNAPSHOT_ORDER.length; // Unknown items go to end
      };
      return getOrderIndex(a) - getOrderIndex(b);
    });
    
    console.log(`  📋 Sorted snapshots: ${snapshots.map(s => s.title).join(', ')}`);
    
    // Import into storage via page.evaluate
    console.log(`  🔄 Importing ${snapshots.length} snapshots into chrome.storage.local...`);
    const result = await page.evaluate(async (snapshots) => {
      try {
        console.log(`[Extension] Starting import of ${snapshots.length} snapshots...`);
        const result = await chrome.storage.local.get(['snapshotIndex']);
        const index = result.snapshotIndex || [];
        console.log(`[Extension] Current snapshot index has ${index.length} items`);
        
        const storageData = {
          snapshotIndex: [...index],
        };
        
        let imported = 0;
        
        for (const snapshot of snapshots) {
          if (!index.includes(snapshot.id)) {
            storageData.snapshotIndex.push(snapshot.id);
            storageData[`snapshot_${snapshot.id}`] = snapshot;
            imported++;
            console.log(`[Extension] Added snapshot: ${snapshot.id} (${snapshot.title})`);
          } else {
            console.log(`[Extension] Snapshot already exists: ${snapshot.id}`);
          }
        }
        
        console.log(`[Extension] Saving ${Object.keys(storageData).length} items to storage...`);
        // Save all snapshots at once
        await chrome.storage.local.set(storageData);
        console.log(`[Extension] Storage save complete`);
        
        // Verify by reading back
        const verify = await chrome.storage.local.get(['snapshotIndex', ...snapshots.map(s => `snapshot_${s.id}`)]);
        console.log(`[Extension] Verification: index has ${verify.snapshotIndex?.length || 0} items, found ${Object.keys(verify).filter(k => k.startsWith('snapshot_') && k !== 'snapshotIndex').length} snapshots`);
        
        return {
          imported,
          total: verify.snapshotIndex?.length || 0,
          verified: Object.keys(verify).filter(k => k.startsWith('snapshot_') && k !== 'snapshotIndex').length
        };
      } catch (error) {
        console.error(`[Extension] Import error:`, error);
        return { error: error.message, stack: error.stack };
      }
    }, snapshots);
    
    if (result.error) {
      console.error(`  ❌ Import failed: ${result.error}`);
      if (result.stack) {
        console.error(`  Stack: ${result.stack}`);
      }
      return { imported: 0, total: 0 };
    }
    
    console.log(`  ✅ Imported ${result.imported} snapshots (${result.total} total in storage, ${result.verified} verified)`);
    return result;
  } catch (error) {
    console.error(`  ❌ Error importing snapshots:`, error.message);
    return { imported: 0, total: 0 };
  }
}

/**
 * Capture real pages using Puppeteer and save to extension storage
 */
async function captureScenario(browser, extensionId, name, config) {
  console.log(`📸 Capturing: ${name}`);
  
  const page = await browser.newPage();
  
  // First, set a large temporary viewport to detect screen dimensions
  await page.setViewport({ width: 2560, height: 1600 });
  
  // Get the actual available screen size
  const screenSize = await page.evaluate(() => {
    return {
      width: window.screen.availWidth,
      height: window.screen.availHeight,
    };
  }).catch(() => ({ width: 1600, height: 1000 }));  // Fallback if screen detection fails
  
  // Use actual screen size for fullscreen capture, then scale down if needed
  const captureWidth = screenSize.width;
  const captureHeight = screenSize.height;
  
  console.log(`  📐 Using screen size: ${captureWidth}×${captureHeight}`);
  
  await page.setViewport({
    width: captureWidth,
    height: captureHeight,
    deviceScaleFactor: 2, // Retina/high-DPI for crisp screenshots
  });
  
  // Ensure page fills the viewport (no zoom)
  await page.evaluate(() => {
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    if (document.documentElement) {
      document.documentElement.style.margin = '0';
      document.documentElement.style.padding = '0';
    }
  });
  
  // Collect console messages for debugging
  const consoleMessages = [];
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleMessages.push(`[${type}] ${text}`);
    }
  });
  
  // Collect page errors
  const pageErrors = [];
  page.on('pageerror', error => {
    pageErrors.push(error.message);
  });
  
  try {
    await config.setup(page, extensionId);
    
    // For Chrome Web Store screenshots (except list view and auto-detect which handle their own waits), 
    // ensure iframe content is loaded
    if (name.includes('chrome-store') && !name.includes('list') && !name.includes('autodetect')) {
      const iframeReady = await waitForIframeContent(page, 15000);
      if (!iframeReady) {
        console.warn(`   ⚠️  Iframe may not be fully loaded, proceeding anyway`);
      }
    }
    
    // Additional wait to ensure page is fully rendered
    await delay(1500);
    
    // Force a repaint to ensure everything is rendered at high DPI
    await page.evaluate(() => {
      // Trigger a repaint
      document.body.style.display = 'none';
      document.body.offsetHeight; // Force reflow
      document.body.style.display = '';
    });
    await delay(500);
    
    const outputPath = path.join(OUTPUT_DIR, config.filename);
    
    // Verify viewport settings
    const viewport = await page.viewport();
    if (viewport && viewport.deviceScaleFactor !== 2) {
      console.warn(`   ⚠️  Warning: deviceScaleFactor is ${viewport.deviceScaleFactor}, expected 2`);
    }
    
    // Take screenshot with high quality settings
    // deviceScaleFactor is already set on viewport (2x for crisp screenshots)
    // This will produce 2x resolution images (e.g., 1440x900 becomes 2880x1800)
    const screenshotOptions = {
      type: 'png',
      // Capture full page or just viewport based on config
      fullPage: config.fullPage ?? false,
      // Ensure high quality
      omitBackground: false, // Include background for better quality
    };
    
    // Add clip option if specified
    if (config.clip) {
      screenshotOptions.clip = config.clip;
    }
    
    // Capture screenshot to buffer
    const screenshotBuffer = await page.screenshot(screenshotOptions);
    
    // Resize if outputSize is specified (scale down from full capture)
    if (config.outputSize) {
      // Chrome Web Store screenshots use actual dimensions (no 2x DPR) and exact fit
      // Other screenshots (features) use 2x DPR for high-DPI displays and preserve content
      const use2xDPR = !name.includes('chrome-store');
      const isChromeStore = name.includes('chrome-store');
      const targetWidth = use2xDPR ? config.outputSize.width * 2 : config.outputSize.width;
      const targetHeight = use2xDPR ? config.outputSize.height * 2 : config.outputSize.height;
      
      const resizedBuffer = await sharp(screenshotBuffer)
        .resize(targetWidth, targetHeight, {
          fit: isChromeStore ? 'cover' : 'inside', // Exact dimensions for Chrome Store, preserve content for others
        })
        .png({ quality: 100 })
        .toBuffer();
      
      await writeFile(outputPath, resizedBuffer);
      const dprNote = use2xDPR ? ' (at 2x DPR)' : '';
      console.log(`   📐 Scaled: ${captureWidth}×${captureHeight} → ${config.outputSize.width}×${config.outputSize.height}${dprNote}`);
    } else {
      // Save full-scale screenshot
      await writeFile(outputPath, screenshotBuffer);
    }
    
    if (consoleMessages.length > 0 || pageErrors.length > 0) {
      console.log(`   ⚠️  Saved with warnings:`);
      if (pageErrors.length > 0) {
        console.log(`      Errors: ${pageErrors.join('; ')}`);
      }
      if (consoleMessages.length > 0) {
        console.log(`      Console: ${consoleMessages.slice(0, 3).join('; ')}`);
      }
    }
    console.log(`   ✓ Saved: ${config.filename}`);
  } catch (error) {
    console.error(`   ✗ Failed: ${error.message}`);
    if (pageErrors.length > 0) {
      console.error(`      Page errors: ${pageErrors.join('; ')}`);
    }
    if (consoleMessages.length > 0) {
      console.error(`      Console: ${consoleMessages.slice(0, 5).join('; ')}`);
    }
  } finally {
    await page.close();
  }
}

async function main() {
  // Validate extension path
  const absoluteExtPath = path.resolve(EXTENSION_PATH);
  if (!existsSync(absoluteExtPath)) {
    console.error(`Extension not found at: ${absoluteExtPath}`);
    console.error('Build the extension first with: npm run build:dev');
    process.exit(1);
  }
  
  // Check for manifest
  const manifestPath = path.join(absoluteExtPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`No manifest.json found in: ${absoluteExtPath}`);
    process.exit(1);
  }
  
  // Clear existing screenshots for a clean start
  console.log('🧹 Clearing existing screenshots...');
  
  if (existsSync(OUTPUT_DIR)) {
    try {
      const files = readdirSync(OUTPUT_DIR);
      for (const file of files) {
        if (file.endsWith('.png')) {
          const filePath = path.join(OUTPUT_DIR, file);
          await rm(filePath, { force: true });
        }
      }
      console.log(`   ✓ Cleared screenshots directory`);
    } catch (error) {
      console.warn(`   ⚠️  Failed to clear screenshots: ${error.message}`);
    }
  }
  
  // Optionally capture pages first if requested (this will clear snapshots)
  if (CAPTURE_PAGES || PAGES_CONFIG) {
    console.log('📥 Capturing pages first...');
    
    // Clear snapshots before capturing new ones
    if (existsSync(SNAPSHOTS_DIR)) {
      try {
        const files = readdirSync(SNAPSHOTS_DIR);
        for (const file of files) {
          if (file.endsWith('.html') || file.endsWith('.json')) {
            const filePath = path.join(SNAPSHOTS_DIR, file);
            await rm(filePath, { force: true });
          }
        }
        console.log(`   ✓ Cleared existing snapshots`);
      } catch (error) {
        console.warn(`   ⚠️  Failed to clear snapshots: ${error.message}`);
      }
    }
    
    try {
      await mkdir(SNAPSHOTS_DIR, { recursive: true });
      
      const capturePagesScript = path.join(__dirname, 'capture-pages.mjs');
      let captureCmd = `node "${capturePagesScript}"`;
      
      if (PAGES_CONFIG) {
        captureCmd += ` --config="${PAGES_CONFIG}"`;
      } else {
        // Use default pages.json if it exists
        const defaultConfig = path.join(SNAPSHOTS_DIR, 'pages.json');
        if (existsSync(defaultConfig)) {
          captureCmd += ` --config="${defaultConfig}"`;
        } else {
          // Use pages.json.example as fallback
          const exampleConfig = path.join(__dirname, 'pages.json.example');
          if (existsSync(exampleConfig)) {
            captureCmd += ` --config="${exampleConfig}"`;
          }
        }
      }
      
      console.log(`   Running: ${captureCmd}`);
      const { stdout, stderr } = await execAsync(captureCmd, { 
        cwd: path.dirname(__dirname),
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });
      if (stdout) console.log(stdout);
      if (stderr) console.warn(stderr);
      
      // Wait for files to be fully written (increase delay for large files)
      await delay(3000);
      
      // Verify snapshots were created and are readable
      let retries = 3;
      let createdSnapshots = [];
      while (retries > 0) {
        try {
          const snapshotFiles = await readdir(SNAPSHOTS_DIR);
          createdSnapshots = snapshotFiles.filter(f => f.endsWith('.json') && f !== 'pages.json' && f !== 'pages.json.example');
          
          // Verify files are actually readable (not just created)
          if (createdSnapshots.length > 0) {
            const testFile = path.join(SNAPSHOTS_DIR, createdSnapshots[0]);
            const testContent = await readFile(testFile, 'utf-8');
            if (testContent && testContent.length > 100) {
              break; // Files are readable
            }
          }
        } catch (e) {
          // Files might still be writing
        }
        retries--;
        if (retries > 0) {
          console.log(`   ⏳ Waiting for snapshot files to be written... (${retries} retries left)`);
      await delay(2000);
        }
      }
      
      console.log(`   ✓ Created ${createdSnapshots.length} snapshot files`);
      if (createdSnapshots.length === 0) {
        console.warn(`   ⚠️  No snapshots were created. Check the capture-pages output above.`);
      } else {
        console.log(`   📂 Snapshot files: ${createdSnapshots.join(', ')}`);
      }
      console.log('');
    } catch (error) {
      console.warn(`   ⚠️  Failed to capture pages: ${error.message}`);
      console.warn(`   Continuing with existing snapshots...`);
      console.log('');
    }
  }
  
  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(SNAPSHOTS_DIR, { recursive: true });
  console.log('');
  
  console.log('🚀 Starting screenshot capture for refine.page');
  console.log(`   Extension: ${absoluteExtPath}`);
  console.log(`   Output: ${OUTPUT_DIR}`);
  console.log('');
  
  // Launch browser with extension
  const browser = await puppeteer.launch({
    headless: false, // Extensions require headed mode
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    args: [
      `--disable-extensions-except=${absoluteExtPath}`,
      `--load-extension=${absoluteExtPath}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      '--start-maximized',
      // Window will be maximized via --start-maximized
      '--force-device-scale-factor=2', // High DPI for crisp screenshots
      '--disable-font-subpixel-positioning', // Better text rendering
      '--disable-lcd-text', // Disable LCD text rendering for consistency
      '--enable-font-antialiasing', // Enable font antialiasing
      // Docker/Chromium specific args
      ...(isDocker ? [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ] : []),
    ],
    defaultViewport: null, // Use full browser window size
    ignoreDefaultArgs: ['--enable-automation'], // Remove automation flags
  });
  
  // Wait for browser and extension to fully initialize
  // In Docker, poll for service worker instead of arbitrary delay
  let extensionId;
  for (let i = 0; i < 30; i++) {
    const targets = await browser.targets();
    const extensionTarget = targets.find(
      target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
    );
    if (extensionTarget) {
      extensionId = new URL(extensionTarget.url()).hostname;
      console.log(`  ✓ Found extension ID: ${extensionId}`);
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  
  if (!extensionId) {
    throw new Error('Failed to find extension service worker after 6 seconds');
  }
  
  console.log(`   Extension ID: ${extensionId}`);
  console.log('');
  
  let importPage = null;
  let defaultPage = null;
  
  // Get the default page - don't close it yet (keeps browser alive in Docker)
  const pages = await browser.pages();
  if (pages.length > 0) {
    defaultPage = pages[0];
  }
  
  try {
    // Import snapshots once before all scenarios (ephemeral profile needs this)
    console.log('📥 Importing snapshots into extension storage...');
    importPage = await browser.newPage();
    
    // Now we can safely close the default page
    if (defaultPage) {
      await defaultPage.close();
      defaultPage = null;
    }
    
    const viewerUrl = `chrome-extension://${extensionId}/viewer.html`;
    await importPage.goto(viewerUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    
    const importResult = await importSnapshotsIntoStorage(importPage, extensionId);
    
    if (importResult.imported === 0 && importResult.total === 0) {
      console.warn('  ⚠️  No snapshots were imported. Make sure you have snapshot files in snapshots/ directory.');
      console.warn('  Run: npm run capture:pages to capture pages first.');
    } else if (importResult.imported > 0) {
      console.log(`  ✅ Successfully imported ${importResult.imported} snapshots`);
      
      // Verify snapshots are actually in storage
      const verifyResult = await importPage.evaluate(async () => {
        try {
          const result = await chrome.storage.local.get(['snapshotIndex']);
          const index = result.snapshotIndex || [];
          return { count: index.length, ids: index };
        } catch (e) {
          return { count: 0, error: e.message };
        }
      });
      
      if (verifyResult.count > 0) {
        console.log(`  ✓ Verified ${verifyResult.count} snapshots in storage`);
      } else {
        console.warn(`  ⚠️  Verification failed: ${verifyResult.error || 'No snapshots found in storage'}`);
      }
      
      // Additional wait to ensure storage is fully synced across all extension contexts
      await delay(2000);
      
      // Reload the import page to ensure storage is persisted
      await importPage.reload({ waitUntil: 'networkidle0' });
      await delay(1000);
      
      // Verify one more time after reload
      const finalVerify = await importPage.evaluate(async () => {
        try {
          const result = await chrome.storage.local.get(['snapshotIndex']);
          return { count: (result.snapshotIndex || []).length };
        } catch (e) {
          return { count: 0, error: e.message };
        }
      });
      
      if (finalVerify.count > 0) {
        console.log(`  ✓ Final verification: ${finalVerify.count} snapshots confirmed in storage`);
      }
    }
    
    // Keep import page open to maintain extension context
    // We'll close it after all scenarios are done
    console.log('');
    
    // Determine which scenarios to run
    let scenariosToRun;
    if (SCENARIO === 'all') {
      scenariosToRun = Object.entries(SCENARIOS);
    } else if (SCENARIO.includes(',')) {
      // Comma-separated list
      const scenarioNames = SCENARIO.split(',').map(s => s.trim());
      scenariosToRun = scenarioNames.map(name => {
        if (!SCENARIOS[name]) {
          console.error(`Unknown scenario: ${name}`);
          process.exit(1);
        }
        return [name, SCENARIOS[name]];
      });
    } else {
      if (!SCENARIOS[SCENARIO]) {
      console.error(`Unknown scenario: ${SCENARIO}`);
        console.error(`Available: ${Object.keys(SCENARIOS).filter(k => !k.startsWith('_')).join(', ')}`);
      process.exit(1);
      }
      scenariosToRun = [[SCENARIO, SCENARIOS[SCENARIO]]];
    }
    
    // Separate base captures and derived scenarios
    const baseCaptures = new Map();
    const directCaptures = [];
    const derivedScenarios = [];
    const neededBases = new Set();
    
    for (const [name, config] of scenariosToRun) {
      if (config.isBase) {
        baseCaptures.set(name, config);
      } else if (config.baseCapture) {
        derivedScenarios.push([name, config]);
        neededBases.add(config.baseCapture);
      } else {
        directCaptures.push([name, config]);
      }
    }
    
    // Step 1: Capture all base images (both explicit and needed for derived scenarios)
    for (const baseName of neededBases) {
      if (!baseCaptures.has(baseName)) {
        const baseConfig = SCENARIOS[baseName];
        if (baseConfig) {
          baseCaptures.set(baseName, baseConfig);
        }
      }
    }
    
    for (const [name, config] of baseCaptures) {
      await captureScenario(browser, extensionId, name, config);
    }
    
    // Step 2: Process derived scenarios from base captures
    for (const [name, config] of derivedScenarios) {
      const baseName = config.baseCapture;
      const baseConfig = SCENARIOS[baseName];
      if (!baseConfig) {
        console.error(`   ✗ Base capture not found: ${baseName}`);
        continue;
      }
      
      const basePath = path.join(OUTPUT_DIR, baseConfig.filename);
      if (!existsSync(basePath)) {
        console.error(`   ✗ Base image not found: ${basePath}`);
        continue;
      }
      
      console.log(`📸 Processing: ${name} (from ${baseName})`);
      
      // Load base image
      const baseImage = sharp(basePath);
      const metadata = await baseImage.metadata();
      
      let outputBuffer;
      if (config.outputSize) {
        // Chrome Web Store screenshots use actual dimensions (no 2x DPR) and exact fit
        // Other screenshots (features) use 2x DPR for high-DPI displays and preserve content
        const use2xDPR = !name.includes('chrome-store');
        const isChromeStore = name.includes('chrome-store');
        const targetWidth = use2xDPR ? config.outputSize.width * 2 : config.outputSize.width;
        const targetHeight = use2xDPR ? config.outputSize.height * 2 : config.outputSize.height;
        outputBuffer = await baseImage
          .resize(targetWidth, targetHeight, {
            fit: isChromeStore ? 'cover' : 'inside', // Exact dimensions for Chrome Store, preserve content for others
          })
          .png({ quality: 100 })
          .toBuffer();
        const dprNote = use2xDPR ? ' (at 2x DPR)' : '';
        console.log(`   📐 Scaled: ${metadata.width}×${metadata.height} → ${config.outputSize.width}×${config.outputSize.height}${dprNote}`);
      } else {
        // Use base image as-is
        outputBuffer = await baseImage.png({ quality: 100 }).toBuffer();
      }
      
      const outputPath = path.join(OUTPUT_DIR, config.filename);
      await writeFile(outputPath, outputBuffer);
      console.log(`   ✓ Saved: ${config.filename}`);
    }
    
    // Step 3: Capture direct scenarios (unique setups)
    for (const [name, config] of directCaptures) {
      await captureScenario(browser, extensionId, name, config);
      // Small delay between scenarios to let Chrome stabilize
      await delay(1000);
    }
    
    // Step 4: Clean up base files
    for (const [name, config] of baseCaptures) {
      const basePath = path.join(OUTPUT_DIR, config.filename);
      if (existsSync(basePath)) {
        await unlink(basePath);
        console.log(`   🗑️  Cleaned up: ${config.filename}`);
      }
    }
    
    console.log('');
    console.log('✅ Screenshot capture complete');
    
  } finally {
    // Close import page if it's still open
    if (importPage) {
      try {
        await importPage.close();
      } catch (e) {
        // Ignore errors when closing
      }
    }
    await browser.close();
  }
}

main().catch(console.error);
