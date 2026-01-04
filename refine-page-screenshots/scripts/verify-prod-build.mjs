#!/usr/bin/env node
/**
 * Verify that production builds don't contain screenshot/dev-only code
 * 
 * Run after building for production:
 *   node scripts/verify-prod-build.js ./dist
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, extname } from 'path';

const DIST_PATH = process.argv[2] || './dist';

const FORBIDDEN_FILES = [
  'demo.html',
  'demo.js',
  'demo.ts',
];

const FORBIDDEN_PATTERNS = [
  /__DEV_SCREENSHOTS__/,
  /__REFINE_SCREENSHOT_READY__/,
  /\/\/\s*DEV-ONLY/,
  /screenshot-mode/,
  /loadDemoState/,
];

let errors = [];
let warnings = [];

async function getAllFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getAllFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function checkFile(filepath) {
  const filename = filepath.split('/').pop();
  
  // Check for forbidden files
  if (FORBIDDEN_FILES.includes(filename)) {
    errors.push(`Forbidden file found: ${filepath}`);
    return;
  }
  
  // Only scan JS/TS/HTML files for patterns
  const ext = extname(filepath);
  if (!['.js', '.ts', '.html', '.mjs', '.cjs'].includes(ext)) {
    return;
  }
  
  const content = await readFile(filepath, 'utf-8');
  
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(`Forbidden pattern ${pattern} found in: ${filepath}`);
    }
  }
}

async function checkManifest() {
  try {
    const manifestPath = join(DIST_PATH, 'manifest.json');
    const content = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    
    // Check web_accessible_resources for demo.html
    const resources = manifest.web_accessible_resources || [];
    for (const resource of resources) {
      const files = resource.resources || [];
      if (files.some(f => f.includes('demo'))) {
        errors.push('manifest.json references demo files in web_accessible_resources');
      }
    }
  } catch (e) {
    warnings.push(`Could not parse manifest.json: ${e.message}`);
  }
}

async function main() {
  console.log(`🔍 Verifying production build at: ${DIST_PATH}\n`);
  
  try {
    await stat(DIST_PATH);
  } catch {
    console.error(`❌ Directory not found: ${DIST_PATH}`);
    process.exit(1);
  }
  
  const files = await getAllFiles(DIST_PATH);
  console.log(`   Scanning ${files.length} files...\n`);
  
  await Promise.all(files.map(checkFile));
  await checkManifest();
  
  // Report results
  if (warnings.length > 0) {
    console.log('⚠️  Warnings:');
    warnings.forEach(w => console.log(`   ${w}`));
    console.log('');
  }
  
  if (errors.length > 0) {
    console.log('❌ Errors found:');
    errors.forEach(e => console.log(`   ${e}`));
    console.log('');
    console.log('🚫 Production build verification FAILED');
    console.log('   Dev-only code would be shipped to users!');
    process.exit(1);
  }
  
  console.log('✅ Production build verification PASSED');
  console.log('   No dev-only screenshot code detected');
}

main().catch(e => {
  console.error('Verification script error:', e);
  process.exit(1);
});
