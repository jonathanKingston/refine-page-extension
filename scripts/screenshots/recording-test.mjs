#!/usr/bin/env node
/**
 * Recording Feature Screenshot Tests for refine.page
 * 
 * This script performs automated testing of the recording functionality
 * with timing measurements and screenshot capture at each step.
 * 
 * Usage:
 *   npm run build
 *   node scripts/screenshots/recording-test.mjs
 *   node scripts/screenshots/recording-test.mjs --extension-path=./dist --verbose
 * 
 * Docker/VM Usage (with Xvfb):
 *   docker-compose -f docker-compose.screenshot-tests.yml up --build
 * 
 * Environment Variables:
 *   PUPPETEER_EXECUTABLE_PATH - Path to Chrome executable (for Docker)
 *   DISPLAY - X11 display for headed mode in Docker (typically :99 with Xvfb)
 */

import puppeteer from 'puppeteer';
import { mkdir, writeFile, rm } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '../../screenshots/recording-tests');
const RESULTS_FILE = path.join(OUTPUT_DIR, 'test-results.json');

// Parse CLI arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  acc[key] = value ?? true;
  return acc;
}, {});

const EXTENSION_PATH = args['extension-path'] || './dist';
const VERBOSE = args['verbose'] !== undefined;

// Detect Docker/container environment
const IS_DOCKER = existsSync('/.dockerenv') || process.env.DOCKER === '1';
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || null;

// Test configuration
const TEST_CONFIG = {
  testPageUrl: 'https://example.com',
  startRecordingTimeout: 10000,
  stopRecordingTimeout: 10000,
  interactionWaitTime: 3000,
  screenshotDelay: 500,
};

// Timing results
const timings = {
  startRecording: null,
  stopRecording: null,
  interactions: [],
  totalTestTime: null,
};

// Test results
const testResults = {
  passed: [],
  failed: [],
  screenshots: [],
  timings: {},
  errors: [],
};

/**
 * Simple delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log with timestamp
 */
function log(message, ...args) {
  const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${timestamp}] ${message}`, ...args);
}

/**
 * Verbose log (only if --verbose flag is set)
 */
function verbose(message, ...args) {
  if (VERBOSE) {
    log(`[VERBOSE] ${message}`, ...args);
  }
}

/**
 * Take a screenshot and save it
 */
async function takeScreenshot(page, name, description) {
  // Use stable names for regression testing (no timestamps)
  const filename = `${name}.png`;
  const filepath = path.join(OUTPUT_DIR, filename);
  
  await page.screenshot({
    path: filepath,
    fullPage: false,
  });
  
  testResults.screenshots.push({
    name,
    description,
    filename,
    timestamp: new Date().toISOString(),
  });
  
  log(`📸 Screenshot saved: ${filename}`);
  return filepath;
}

/**
 * Get extension ID from browser
 */
async function getExtensionId(browser) {
  for (let i = 0; i < 10; i++) {
    const targets = await browser.targets();
    const extensionTarget = targets.find(
      target => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://')
    );
    
    if (extensionTarget) {
      const url = new URL(extensionTarget.url());
      return url.hostname;
    }
    
    await delay(200);
  }
  
  throw new Error('Could not find extension service worker');
}

/**
 * Open the popup and get a reference to it
 */
async function openPopup(browser, extensionId) {
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const page = await browser.newPage();
  await page.goto(popupUrl, { waitUntil: 'networkidle0' });
  return page;
}

/**
 * Test: Recording Start Performance
 */
async function testRecordingStart(popupPage, testPage, extensionId) {
  log('🧪 TEST: Recording Start Performance');
  
  try {
    // Wait for popup to be ready
    await popupPage.waitForSelector('#start-recording-btn', { timeout: 5000 });
    await takeScreenshot(popupPage, '01-popup-ready', 'Popup loaded and ready');
    
    // Measure start recording time
    const startTime = performance.now();
    
    // Click start recording
    await popupPage.click('#start-recording-btn');
    verbose('Clicked start recording button');
    
    // Wait for recording to actually start (button should change to stop)
    await popupPage.waitForFunction(() => {
      const stopBtn = document.getElementById('stop-recording-btn');
      return stopBtn && stopBtn.style.display !== 'none';
    }, { timeout: TEST_CONFIG.startRecordingTimeout });
    
    const endTime = performance.now();
    timings.startRecording = endTime - startTime;
    
    log(`✅ Recording started in ${timings.startRecording.toFixed(0)}ms`);
    await takeScreenshot(popupPage, '02-recording-started', 'Recording has started');
    
    // Verify recording indicator is active
    const indicatorActive = await popupPage.evaluate(() => {
      const indicator = document.getElementById('recording-indicator');
      return indicator?.classList.contains('active');
    });
    
    if (indicatorActive) {
      testResults.passed.push('Recording indicator shows active state');
    } else {
      testResults.failed.push('Recording indicator not showing active state');
    }
    
    // Check test page for recording state (poll until ready or timeout)
    const pageRecordingState = await testPage.evaluate(async () => {
      // Poll for recording state with exponential backoff
      for (let i = 0; i < 10; i++) {
        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (r) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(r);
            });
          });
          if (response?.isRecording) return response;
        } catch {}
        await new Promise(r => setTimeout(r, 50 * Math.pow(1.5, i))); // 50, 75, 112, 168...ms
      }
      return null;
    }).catch(() => null);
    
    verbose('Page recording state:', pageRecordingState);
    
    return true;
  } catch (error) {
    log(`❌ Recording start test failed: ${error.message}`);
    testResults.failed.push(`Recording start: ${error.message}`);
    testResults.errors.push({ test: 'recordingStart', error: error.message });
    return false;
  }
}

/**
 * Test: Interaction Recording
 */
async function testInteractionRecording(testPage, extensionId) {
  log('🧪 TEST: Interaction Recording');
  
  try {
    // Navigate to test page
    await takeScreenshot(testPage, '03-test-page-before', 'Test page before interactions');
    
    // Perform a click interaction
    const clickStartTime = performance.now();
    
    // Click on the "More information..." link on example.com
    const link = await testPage.$('a');
    if (link) {
      await link.click();
      verbose('Clicked link on test page');
    } else {
      // If no link, just click somewhere on the page
      await testPage.click('body');
      verbose('Clicked on page body');
    }
    
    // Wait for interaction to be processed
    await delay(TEST_CONFIG.interactionWaitTime);
    
    const clickEndTime = performance.now();
    timings.interactions.push({
      type: 'click',
      duration: clickEndTime - clickStartTime,
    });
    
    log(`✅ Click interaction processed in ${(clickEndTime - clickStartTime).toFixed(0)}ms`);
    await takeScreenshot(testPage, '04-after-click', 'Test page after click interaction');
    
    testResults.passed.push('Click interaction recorded');
    return true;
  } catch (error) {
    log(`❌ Interaction recording test failed: ${error.message}`);
    testResults.failed.push(`Interaction recording: ${error.message}`);
    testResults.errors.push({ test: 'interactionRecording', error: error.message });
    return false;
  }
}

/**
 * Test: Recording Stop Performance
 */
async function testRecordingStop(popupPage, extensionId) {
  log('🧪 TEST: Recording Stop Performance');
  
  try {
    // Wait for stop button to be visible
    await popupPage.waitForSelector('#stop-recording-btn:not([style*="display: none"])', { timeout: 5000 });
    await takeScreenshot(popupPage, '05-before-stop', 'Popup before stopping recording');
    
    // Measure stop recording time
    const startTime = performance.now();
    
    // Click stop recording
    await popupPage.click('#stop-recording-btn');
    verbose('Clicked stop recording button');
    
    // Wait for recording to stop (button should change back to start)
    await popupPage.waitForFunction(() => {
      const startBtn = document.getElementById('start-recording-btn');
      return startBtn && startBtn.style.display !== 'none';
    }, { timeout: TEST_CONFIG.stopRecordingTimeout });
    
    const endTime = performance.now();
    timings.stopRecording = endTime - startTime;
    
    log(`✅ Recording stopped in ${timings.stopRecording.toFixed(0)}ms`);
    await takeScreenshot(popupPage, '06-recording-stopped', 'Recording has stopped');
    
    // Handle the confirm dialog that appears after stopping
    // The popup.ts shows a confirm() asking to view the trace
    // We need to handle this in the test
    
    testResults.passed.push('Recording stop completed');
    return true;
  } catch (error) {
    log(`❌ Recording stop test failed: ${error.message}`);
    testResults.failed.push(`Recording stop: ${error.message}`);
    testResults.errors.push({ test: 'recordingStop', error: error.message });
    return false;
  }
}

/**
 * Test: Regular Page Capture (non-recording mode)
 * This tests if the basic "Capture Page" functionality works
 */
async function testRegularCapture(popupPage, testPage, extensionId) {
  log('🧪 TEST: Regular Page Capture (Capture Page button)');
  
  try {
    // Make sure the test page is active and focused BEFORE opening popup
    // This is critical because CAPTURE_PAGE queries for the active tab
    await testPage.bringToFront();
    await testPage.click('body'); // Ensure page is truly focused
    
    // Now bring popup to front
    await popupPage.bringToFront();
    
    // Wait for capture button
    await popupPage.waitForSelector('#capture-btn', { timeout: 5000 });
    
    // Set up console listener to capture any errors
    const consoleMessages = [];
    popupPage.on('console', msg => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
      if (msg.type() === 'error') {
        log(`   ⚠️ Console error: ${msg.text()}`);
      }
    });
    
    // Check initial snapshot count
    const beforeCount = await popupPage.evaluate(async () => {
      const result = await chrome.storage.local.get('snapshotIndex');
      return (result.snapshotIndex || []).length;
    });
    log(`   Snapshots before capture: ${beforeCount}`);
    
    // First, find the test page tab ID
    const tabs = await popupPage.evaluate(async () => {
      const allTabs = await chrome.tabs.query({});
      return allTabs.map(t => ({ id: t.id, url: t.url, active: t.active }));
    });
    log(`   Found ${tabs.length} tabs: ${tabs.map(t => t.url?.substring(0, 40)).join(', ')}`);
    
    // Find the example.com tab
    const testTab = tabs.find(t => t.url?.includes('example.com'));
    if (!testTab) {
      log('   ❌ Could not find example.com tab!');
      testResults.failed.push('Regular capture: test page tab not found');
      return false;
    }
    log(`   Test tab ID: ${testTab.id}, URL: ${testTab.url}`);
    
    // Make the test tab active AND focused
    await popupPage.evaluate(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      // Also focus the window containing the tab
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    }, testTab.id);
    // Minimal wait just for Chrome to process the focus change
    await delay(100);
    
    // Verify the test tab is accessible before capture
    const tabAccessCheck = await popupPage.evaluate(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        // Try to send a message to verify content script access
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        } catch {
          // Content script might not respond to PING, that's ok
        }
        return { 
          accessible: true, 
          url: tab.url, 
          status: tab.status,
          active: tab.active 
        };
      } catch (error) {
        return { accessible: false, error: error.message };
      }
    }, testTab.id);
    log(`   Tab accessibility: ${JSON.stringify(tabAccessCheck)}`);
    
    // Try to capture via direct message to background (bypassing popup UI)
    log('   Testing direct CAPTURE_PAGE message to background...');
    const directCaptureResult = await popupPage.evaluate(async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE' });
        return { success: true, response };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    if (directCaptureResult.success) {
      log(`   ✅ Direct capture message sent`);
      log(`   Response: ${JSON.stringify(directCaptureResult.response)}`);
      if (directCaptureResult.response?.payload?.error) {
        log(`   ⚠️ Capture returned error: ${directCaptureResult.response.payload.error}`);
        if (directCaptureResult.response.payload.stack) {
          log(`   Stack trace: ${directCaptureResult.response.payload.stack}`);
        }
      }
    } else {
      log(`   ❌ Direct capture failed: ${directCaptureResult.error}`);
    }
    
    // Poll for snapshot count increase (with timeout)
    const afterCount = await popupPage.evaluate(async (expectedCount) => {
      const startTime = Date.now();
      const timeout = 30000; // 30 second max wait
      while (Date.now() - startTime < timeout) {
        const result = await chrome.storage.local.get('snapshotIndex');
        const count = (result.snapshotIndex || []).length;
        if (count > expectedCount) return count;
        await new Promise(r => setTimeout(r, 200));
      }
      // Return current count even if timeout
      const result = await chrome.storage.local.get('snapshotIndex');
      return (result.snapshotIndex || []).length;
    }, beforeCount);
    log(`   Snapshots after capture: ${afterCount}`);
    
    // Log any console messages for debugging
    if (consoleMessages.length > 0) {
      verbose('   Console messages:', JSON.stringify(consoleMessages, null, 2));
    }
    
    await takeScreenshot(popupPage, '00-after-regular-capture', 'Popup after regular capture');
    
    if (afterCount > beforeCount) {
      testResults.passed.push(`Regular capture works: ${afterCount - beforeCount} snapshot(s) created`);
      return true;
    } else {
      testResults.failed.push(`Regular capture failed: ${directCaptureResult.error || 'no new snapshots created'}`);
      return false;
    }
  } catch (error) {
    log(`❌ Regular capture test failed: ${error.message}`);
    testResults.failed.push(`Regular capture: ${error.message}`);
    testResults.errors.push({ test: 'regularCapture', error: error.message });
    return false;
  }
}

/**
 * Test: Verify Trace Created
 */
async function testVerifyTrace(browser, extensionId) {
  log('🧪 TEST: Verify Trace Created');
  
  try {
    // Open viewer page to check storage
    const viewerPage = await browser.newPage();
    const viewerUrl = `chrome-extension://${extensionId}/viewer.html`;
    await viewerPage.goto(viewerUrl, { waitUntil: 'networkidle0' });
    // No delay needed - networkidle0 already waits for page to be ready
    
    // Check storage for traces
    const storageData = await viewerPage.evaluate(async () => {
      const result = await chrome.storage.local.get(null);
      const traceIndex = result.traceIndex || [];
      const snapshotIndex = result.snapshotIndex || [];
      
      // Get trace details
      const traces = [];
      for (const traceId of traceIndex) {
        const trace = result[`trace_${traceId}`];
        if (trace) {
          traces.push({
            id: trace.id,
            interactionCount: trace.interactions?.length || 0,
            hasInitialSnapshot: !!trace.initialSnapshotId,
            hasFinalSnapshot: !!trace.finalSnapshotId,
            initialSnapshotId: trace.initialSnapshotId || null,
            finalSnapshotId: trace.finalSnapshotId || null,
            startedAt: trace.startedAt,
            stoppedAt: trace.stoppedAt,
          });
        }
      }
      
      return {
        traceCount: traceIndex.length,
        snapshotCount: snapshotIndex.length,
        traces,
      };
    });
    
    log(`📊 Storage data: ${storageData.traceCount} traces, ${storageData.snapshotCount} snapshots`);
    verbose('Traces:', JSON.stringify(storageData.traces, null, 2));
    
    await takeScreenshot(viewerPage, '07-viewer-with-data', 'Viewer page showing recorded data');
    
    // Validate results
    if (storageData.traceCount > 0) {
      testResults.passed.push(`Found ${storageData.traceCount} trace(s) in storage`);
    } else {
      testResults.failed.push('No traces found in storage');
    }
    
    if (storageData.snapshotCount > 0) {
      testResults.passed.push(`Found ${storageData.snapshotCount} snapshot(s) in storage`);
    } else {
      testResults.failed.push('No snapshots found in storage');
    }
    
    // Check if trace has interactions
    const latestTrace = storageData.traces[storageData.traces.length - 1];
    if (latestTrace) {
      testResults.passed.push(`Latest trace has ${latestTrace.interactionCount} interaction(s)`);
      
      log(`   Trace details: initialSnapshotId=${latestTrace.initialSnapshotId || 'none'}, finalSnapshotId=${latestTrace.finalSnapshotId || 'none'}`);
      
      if (latestTrace.hasInitialSnapshot) {
        testResults.passed.push(`Trace has initial snapshot: ${latestTrace.initialSnapshotId}`);
      } else {
        testResults.failed.push('Trace missing initial snapshot');
      }
      
      if (latestTrace.hasFinalSnapshot) {
        testResults.passed.push(`Trace has final snapshot: ${latestTrace.finalSnapshotId}`);
      } else {
        testResults.failed.push('Trace missing final snapshot');
      }
    }
    
    await viewerPage.close();
    return storageData;
  } catch (error) {
    log(`❌ Verify trace test failed: ${error.message}`);
    testResults.failed.push(`Verify trace: ${error.message}`);
    testResults.errors.push({ test: 'verifyTrace', error: error.message });
    return null;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  const testStartTime = performance.now();
  log('🚀 Starting Recording Feature Tests');
  log(`   Extension path: ${EXTENSION_PATH}`);
  log(`   Output directory: ${OUTPUT_DIR}`);
  console.log('');
  
  // Validate extension path
  const absoluteExtPath = path.resolve(EXTENSION_PATH);
  if (!existsSync(absoluteExtPath)) {
    console.error(`❌ Extension not found at: ${absoluteExtPath}`);
    console.error('   Run "npm run build" first');
    process.exit(1);
  }
  
  // Clean and create output directory
  if (existsSync(OUTPUT_DIR)) {
    const files = readdirSync(OUTPUT_DIR);
    for (const file of files) {
      await rm(path.join(OUTPUT_DIR, file), { force: true });
    }
  }
  await mkdir(OUTPUT_DIR, { recursive: true });
  
  // Build Chrome launch arguments
  const chromeArgs = [
    `--disable-extensions-except=${absoluteExtPath}`,
    `--load-extension=${absoluteExtPath}`,
    '--no-first-run',
    '--disable-default-apps',
    '--disable-popup-blocking',
  ];

  // Add Docker/Xvfb-specific flags
  if (IS_DOCKER) {
    log('🐳 Running in Docker environment - configuring for Xvfb');
    chromeArgs.push(
      '--no-sandbox',           // Required in Docker
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Use /tmp instead of /dev/shm (limited in Docker)
      '--disable-gpu',           // GPU not available in Docker
      '--window-size=1920,1080', // Set explicit window size for Xvfb
    );
  }

  // Launch browser with extension
  const launchOptions = {
    headless: false, // Must be false to load extensions
    args: chromeArgs,
    defaultViewport: { width: 1280, height: 800 },
  };

  // Use custom Chrome path if specified (e.g., in Docker)
  if (CHROME_PATH) {
    launchOptions.executablePath = CHROME_PATH;
    log(`🔧 Using Chrome at: ${CHROME_PATH}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  
  let popupPage = null;
  let testPage = null;
  
  try {
    // getExtensionId already has retry logic, no need for extra delay
    const extensionId = await getExtensionId(browser);
    log(`✅ Extension loaded: ${extensionId}`);
    
    // Validate extension has correct permissions
    const manifestPage = await browser.newPage();
    await manifestPage.goto(`chrome-extension://${extensionId}/manifest.json`);
    const manifestText = await manifestPage.evaluate(() => document.body.innerText);
    await manifestPage.close();
    
    try {
      const manifest = JSON.parse(manifestText);
      const hasHostPermissions = manifest.host_permissions?.includes('<all_urls>');
      if (hasHostPermissions) {
        log('✅ Extension has host_permissions: <all_urls>');
      } else {
        log('❌ ERROR: Extension missing host_permissions! Run with build:dev');
        testResults.errors.push({ test: 'setup', error: 'Missing host_permissions' });
      }
    } catch (e) {
      log(`⚠️ Could not validate manifest: ${e.message}`);
    }
    
    // Open test page first
    testPage = await browser.newPage();
    await testPage.goto(TEST_CONFIG.testPageUrl, { waitUntil: 'networkidle0' });
    log(`✅ Test page loaded: ${TEST_CONFIG.testPageUrl}`);
    
    // Inject dialog handler to auto-dismiss confirm dialogs
    await testPage.evaluate(() => {
      window.confirm = () => false; // Auto-cancel confirm dialogs
    });
    
    // Open popup
    popupPage = await openPopup(browser, extensionId);
    log('✅ Popup opened');
    
    // Also inject dialog handler in popup
    await popupPage.evaluate(() => {
      window.confirm = () => false; // Auto-cancel confirm dialogs
    });
    
    // Run tests
    console.log('');
    log('═══════════════════════════════════════════════════════════');
    
    // First test regular capture to see if basic functionality works
    await testRegularCapture(popupPage, testPage, extensionId);
    
    log('───────────────────────────────────────────────────────────');
    
    await testRecordingStart(popupPage, testPage, extensionId);
    
    log('───────────────────────────────────────────────────────────');
    
    await testInteractionRecording(testPage, extensionId);
    
    log('───────────────────────────────────────────────────────────');
    
    // Re-open popup (it may have been closed or navigated)
    await popupPage.close();
    popupPage = await openPopup(browser, extensionId);
    await popupPage.evaluate(() => {
      window.confirm = () => false;
    });
    // Wait for popup to show recording state
    await popupPage.waitForSelector('#stop-recording-btn', { timeout: 5000 }).catch(() => {});
    
    await testRecordingStop(popupPage, extensionId);
    
    log('───────────────────────────────────────────────────────────');
    
    await testVerifyTrace(browser, extensionId);
    
    log('═══════════════════════════════════════════════════════════');
    console.log('');
    
  } finally {
    // Close browser
    await browser.close();
  }
  
  // Calculate total test time
  const testEndTime = performance.now();
  timings.totalTestTime = testEndTime - testStartTime;
  
  // Prepare final results
  testResults.timings = {
    startRecording: timings.startRecording,
    stopRecording: timings.stopRecording,
    interactions: timings.interactions,
    totalTestTime: timings.totalTestTime,
  };
  
  // Save results to file
  await writeFile(RESULTS_FILE, JSON.stringify(testResults, null, 2));
  
  // Print summary
  console.log('');
  log('╔═══════════════════════════════════════════════════════════╗');
  log('║               TEST RESULTS SUMMARY                        ║');
  log('╠═══════════════════════════════════════════════════════════╣');
  log(`║  Total tests passed: ${testResults.passed.length.toString().padEnd(35)}║`);
  log(`║  Total tests failed: ${testResults.failed.length.toString().padEnd(35)}║`);
  log(`║  Screenshots taken: ${testResults.screenshots.length.toString().padEnd(36)}║`);
  log('╠═══════════════════════════════════════════════════════════╣');
  log('║  TIMING MEASUREMENTS                                      ║');
  log(`║  Start recording: ${timings.startRecording ? timings.startRecording.toFixed(0) + 'ms' : 'N/A'}`.padEnd(60) + '║');
  log(`║  Stop recording: ${timings.stopRecording ? timings.stopRecording.toFixed(0) + 'ms' : 'N/A'}`.padEnd(60) + '║');
  log(`║  Total test time: ${(timings.totalTestTime / 1000).toFixed(1)}s`.padEnd(60) + '║');
  log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Print passed tests
  if (testResults.passed.length > 0) {
    log('✅ PASSED:');
    testResults.passed.forEach(t => log(`   • ${t}`));
  }
  
  // Print failed tests
  if (testResults.failed.length > 0) {
    console.log('');
    log('❌ FAILED:');
    testResults.failed.forEach(t => log(`   • ${t}`));
  }
  
  console.log('');
  log(`📁 Results saved to: ${RESULTS_FILE}`);
  log(`📸 Screenshots saved to: ${OUTPUT_DIR}`);
  
  // Exit with appropriate code
  const exitCode = testResults.failed.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
