#!/usr/bin/env node
/**
 * Capture web pages as snapshots using the extension's built-in capture functionality.
 * 
 * This script:
 * 1. Launches Chrome with the extension loaded
 * 2. Attaches to the background service worker to capture its logs  
 * 3. Opens each target URL in a new tab
 * 4. Uses the extension's CAPTURE_PAGE message to capture the page
 * 5. Saves the HTML and metadata to the snapshots directory
 * 
 * IMPORTANT: Must use `npm run build:dev` first, which adds:
 * - `tabs` permission (query any tab, not just user-invoked ones)
 * - `<all_urls>` host permission (access any page programmatically)
 */

import puppeteer from 'puppeteer';
import { existsSync, readdirSync, unlinkSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');
const SNAPSHOTS_DIR = join(PROJECT_ROOT, 'snapshots');

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let urls = [];
  let configPath = null;
  let extensionPath = join(PROJECT_ROOT, 'dist');
  let headless = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--urls' && args[i + 1]) {
      urls = args[++i].split(',').map(u => u.trim());
    } else if (args[i] === '--config' && args[i + 1]) {
      configPath = args[++i];
    } else if (args[i] === '--extension-path' && args[i + 1]) {
      extensionPath = args[++i];
    } else if (args[i] === '--headless') {
      headless = true;
    }
  }

  // Default to example config if no URLs provided
  if (urls.length === 0 && !configPath) {
    const defaultConfig = join(__dirname, 'pages.json.example');
    if (existsSync(defaultConfig)) {
      configPath = defaultConfig;
    }
  }

  // Load URLs from config file
  if (configPath && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    urls = config.pages || [];
  }

  return { urls, extensionPath, headless };
}

// Clear existing snapshots
function clearSnapshots() {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    return;
  }
  
  const files = readdirSync(SNAPSHOTS_DIR);
  let cleared = 0;
  for (const file of files) {
    if (file.endsWith('.html') || file.endsWith('.json')) {
      unlinkSync(join(SNAPSHOTS_DIR, file));
      cleared++;
    }
  }
  if (cleared > 0) {
    console.log(`🧹 Cleared ${cleared} existing snapshots`);
  }
}

// Get extension ID by scanning targets
async function getExtensionId(browser) {
  const targets = await browser.targets();
  for (const target of targets) {
    const url = target.url();
    if (url.startsWith('chrome-extension://') && url.includes('background')) {
      const match = url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) return match[1];
    }
  }
  
  // Fallback: look for any extension target
  for (const target of targets) {
    const url = target.url();
    if (url.startsWith('chrome-extension://')) {
      const match = url.match(/chrome-extension:\/\/([^/]+)/);
      if (match) return match[1];
    }
  }
  
  throw new Error('Extension ID not found');
}

// Attach to service worker and log its console output
async function attachToServiceWorker(browser, extensionId) {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().includes(extensionId),
    { timeout: 10000 }
  );
  
  const swSession = await swTarget.createCDPSession();
  await swSession.send('Runtime.enable');
  
  // Log all console messages from the service worker
  swSession.on('Runtime.consoleAPICalled', (params) => {
    const args = params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' ');
    console.log(`[SW] ${args}`);
  });
  
  // Log exceptions
  swSession.on('Runtime.exceptionThrown', (params) => {
    console.error(`[SW ERROR] ${params.exceptionDetails.text}`);
    if (params.exceptionDetails.exception) {
      console.error(`[SW ERROR] ${params.exceptionDetails.exception.description || params.exceptionDetails.exception.value}`);
    }
  });
  
  console.log('   ✓ Attached to service worker for logging');
  return swSession;
}

// Capture a single page
async function capturePage(browser, extensionId, url) {
  console.log(`\n📥 Capturing: ${url}`);
  
  // Open extension page to send messages from
  const extensionPage = await browser.newPage();
  
  // Log extension page console
  extensionPage.on('console', msg => console.log(`[EXT] ${msg.text()}`));
  extensionPage.on('pageerror', err => console.error(`[EXT ERROR] ${err.message}`));
  
  try {
    const viewerUrl = `chrome-extension://${extensionId}/viewer.html`;
    await extensionPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    
    // Create the target tab and wait for it to load
    // With `tabs` permission, we can create and query any tab
    console.log(`   Creating tab for: ${url}`);
    
    const result = await extensionPage.evaluate(async (targetUrl) => {
      return new Promise((resolve, reject) => {
        // Create the tab
        chrome.tabs.create({ url: targetUrl, active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          
          if (!tab || !tab.id) {
            reject(new Error('Failed to create tab'));
            return;
          }
          
          const tabId = tab.id;
          console.log(`[capture] Tab created: ${tabId}`);
          
          // Wait for the tab to finish loading
          const onUpdated = (updatedId, changeInfo, updatedTab) => {
            if (updatedId !== tabId) return;
            
            console.log(`[capture] Tab ${tabId} status: ${changeInfo.status}, url: ${updatedTab?.url}`);
            
            if (changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              
              // Small delay for content scripts to initialize
              setTimeout(() => {
                console.log(`[capture] Tab ${tabId} ready, sending CAPTURE_PAGE`);
                
                chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE' }, (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                  }
                  
                  console.log(`[capture] CAPTURE_PAGE response:`, JSON.stringify(response));
                  
                  // Close the captured tab
                  chrome.tabs.remove(tabId, () => {
                    if (response && response.type === 'CAPTURE_COMPLETE') {
                      resolve({ snapshotId: response.payload.snapshotId });
                    } else if (response && response.error) {
                      reject(new Error(response.error));
                    } else if (response && response.type === 'CAPTURE_ERROR') {
                      reject(new Error(response.payload?.error || 'Capture failed'));
                    } else {
                      reject(new Error('Unexpected response: ' + JSON.stringify(response)));
                    }
                  });
                });
              }, 500);
            }
          };
          
          chrome.tabs.onUpdated.addListener(onUpdated);
          
          // Timeout after 30 seconds
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.remove(tabId, () => {});
            reject(new Error('Tab load timeout'));
          }, 30000);
        });
      });
    }, url);
    
    console.log(`   ✓ Captured: ${result.snapshotId}`);
    
    // Retrieve the snapshot from storage
    const snapshot = await extensionPage.evaluate(async (snapshotId) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT', payload: { id: snapshotId } }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('Snapshot not found'));
            return;
          }
          resolve(response);
        });
      });
    }, result.snapshotId);
    
    await extensionPage.close();
    
    return snapshot;
    
  } catch (error) {
    await extensionPage.close().catch(() => {});
    throw error;
  }
}

// Save snapshot to disk
function saveSnapshot(snapshot) {
  const safeName = snapshot.url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .substring(0, 100);
  
  const htmlPath = join(SNAPSHOTS_DIR, `${safeName}.html`);
  const metaPath = join(SNAPSHOTS_DIR, `${safeName}.json`);
  
  writeFileSync(htmlPath, snapshot.html);
  writeFileSync(metaPath, JSON.stringify({
    id: snapshot.id,
    url: snapshot.url,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    viewport: snapshot.viewport
  }, null, 2));
  
  console.log(`   ✓ Saved: ${safeName}.html (${(snapshot.html.length / 1024).toFixed(1)} KB)`);
}

// Main
async function main() {
  const { urls, extensionPath, headless } = parseArgs();
  
  if (urls.length === 0) {
    console.error('No URLs provided. Use --urls or --config');
    process.exit(1);
  }
  
  if (!existsSync(extensionPath)) {
    console.error(`Extension not found at: ${extensionPath}`);
    console.error('Run: npm run build:dev');
    process.exit(1);
  }
  
  // Check for dev build
  const manifest = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf-8'));
  if (!manifest.permissions?.includes('tabs')) {
    console.error('❌ Extension was not built with dev permissions.');
    console.error('   The `tabs` permission is required for automation.');
    console.error('   Run: npm run build:dev');
    process.exit(1);
  }
  
  clearSnapshots();
  
  console.log('\n🚀 Starting page capture');
  console.log(`   Extension: ${extensionPath}`);
  console.log(`   URLs: ${urls.length} page(s)`);
  
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    defaultViewport: null, // Use window size instead of fixed viewport
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-popup-blocking',
      '--start-maximized',
      '--window-size=1920,1080',
      '--force-device-scale-factor=2',
    ]
  });
  
  try {
    // Get extension ID
    await new Promise(r => setTimeout(r, 2000)); // Wait for extension to load
    const extensionId = await getExtensionId(browser);
    console.log(`   Extension ID: ${extensionId}`);
    
    // Attach to service worker to see its logs
    await attachToServiceWorker(browser, extensionId);
    
    // Capture each page
    let successful = 0;
    const errors = [];
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n[${i + 1}/${urls.length}] ${url}`);
      
      try {
        const snapshot = await capturePage(browser, extensionId, url);
        saveSnapshot(snapshot);
        successful++;
      } catch (error) {
        console.error(`   ❌ Failed: ${error.message}`);
        errors.push({ url, error: error.message });
      }
    }
    
    console.log(`\n✅ Captured ${successful} of ${urls.length} pages`);
    
    if (errors.length > 0) {
      console.log('\n❌ Failed pages:');
      for (const { url, error } of errors) {
        console.log(`   ${url}: ${error}`);
      }
      process.exit(1);
    }
    
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
