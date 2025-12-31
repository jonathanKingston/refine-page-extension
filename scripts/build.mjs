import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, cpSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');

const isWatch = process.argv.includes('--watch');

// Clean dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

// Entry points for the extension
const entryPoints = {
  'background': join(srcDir, 'background/background.ts'),
  'content': join(srcDir, 'content/capture.ts'),
  'popup': join(srcDir, 'popup/popup.ts'),
  'viewer': join(srcDir, 'viewer/viewer.ts'),
  'snapshot': join(srcDir, 'snapshot/snapshot.ts'),
  'iframe-annotator': join(srcDir, 'iframe/annotator.ts'),
};

// Common esbuild options
const commonOptions = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  alias: {
    '@': srcDir,
  },
};

// Plugin to handle CSS imports by inlining them as JS that injects styles
const inlineCssPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = readFileSync(args.path, 'utf8');
      // Escape backticks and backslashes for template literal
      const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
      return {
        contents: `
          (function() {
            if (typeof document !== 'undefined') {
              const style = document.createElement('style');
              style.textContent = \`${escaped}\`;
              document.head.appendChild(style);
            }
          })();
        `,
        loader: 'js',
      };
    });
  },
};

// Build scripts
async function buildScripts() {
  // Background script (service worker - needs iife format)
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints.background],
    outfile: join(distDir, 'background.js'),
    format: 'iife',
  });

  // Content script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints.content],
    outfile: join(distDir, 'content.js'),
    format: 'iife',
  });

  // Popup script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints.popup],
    outfile: join(distDir, 'popup.js'),
  });

  // Viewer script - with CSS inlining for annotation libraries
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints.viewer],
    outfile: join(distDir, 'viewer.js'),
    plugins: [inlineCssPlugin],
  });

  // Snapshot viewer script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints.snapshot],
    outfile: join(distDir, 'snapshot.js'),
  });

  // Iframe annotator script - runs inside iframe, needs CSS inlining and IIFE format
  await esbuild.build({
    ...commonOptions,
    entryPoints: [entryPoints['iframe-annotator']],
    outfile: join(distDir, 'iframe-annotator.js'),
    format: 'iife',
    plugins: [inlineCssPlugin],
  });
}

// Copy static files
function copyStaticFiles() {
  // Copy and transform manifest
  const manifest = JSON.parse(readFileSync(join(rootDir, 'manifest.json'), 'utf-8'));

  // Update paths in manifest for dist
  manifest.background = { service_worker: 'background.js' }; // Remove "type": "module" since we use IIFE
  manifest.content_scripts[0].js = ['content.js'];
  manifest.action.default_popup = 'popup.html';
  manifest.web_accessible_resources[0].resources = [
    'viewer.html', 'viewer.js', 'viewer.css',
    'snapshot.html', 'snapshot.js',
    'iframe.html', 'iframe-annotator.js'
  ];

  writeFileSync(join(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Copy HTML files with updated script paths
  const popupHtml = readFileSync(join(srcDir, 'popup/popup.html'), 'utf-8')
    .replace('src="popup.ts"', 'src="popup.js"')
    .replace('href="popup.css"', 'href="popup.css"');
  writeFileSync(join(distDir, 'popup.html'), popupHtml);

  const viewerHtml = readFileSync(join(srcDir, 'viewer/viewer.html'), 'utf-8')
    .replace('src="viewer.ts"', 'src="viewer.js"')
    .replace('href="viewer.css"', 'href="viewer.css"');
  writeFileSync(join(distDir, 'viewer.html'), viewerHtml);

  const snapshotHtml = readFileSync(join(srcDir, 'snapshot/snapshot.html'), 'utf-8')
    .replace('src="snapshot.ts"', 'src="snapshot.js"');
  writeFileSync(join(distDir, 'snapshot.html'), snapshotHtml);

  // Copy iframe.html (used for annotation in iframe context)
  copyFileSync(join(srcDir, 'iframe/iframe.html'), join(distDir, 'iframe.html'));

  // Copy CSS files
  if (existsSync(join(srcDir, 'popup/popup.css'))) {
    copyFileSync(join(srcDir, 'popup/popup.css'), join(distDir, 'popup.css'));
  }
  if (existsSync(join(srcDir, 'viewer/viewer.css'))) {
    copyFileSync(join(srcDir, 'viewer/viewer.css'), join(distDir, 'viewer.css'));
  }

  // Copy icons
  if (existsSync(join(rootDir, 'icons'))) {
    cpSync(join(rootDir, 'icons'), join(distDir, 'icons'), { recursive: true });
  }
}

// Build function
async function build() {
  console.log('Building Page Labeller extension...');
  const start = Date.now();

  try {
    await buildScripts();
    copyStaticFiles();
    console.log(`Build completed in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Watch mode
async function watch() {
  console.log('Starting watch mode...');

  // Initial build
  await build();

  // Watch for changes using esbuild context
  const contexts = await Promise.all([
    esbuild.context({
      ...commonOptions,
      entryPoints: [entryPoints.background],
      outfile: join(distDir, 'background.js'),
      format: 'iife',
    }),
    esbuild.context({
      ...commonOptions,
      entryPoints: [entryPoints.content],
      outfile: join(distDir, 'content.js'),
      format: 'iife',
    }),
    esbuild.context({
      ...commonOptions,
      entryPoints: [entryPoints.popup],
      outfile: join(distDir, 'popup.js'),
    }),
    esbuild.context({
      ...commonOptions,
      entryPoints: [entryPoints.viewer],
      outfile: join(distDir, 'viewer.js'),
      plugins: [inlineCssPlugin],
    }),
    esbuild.context({
      ...commonOptions,
      entryPoints: [entryPoints.snapshot],
      outfile: join(distDir, 'snapshot.js'),
    }),
  ]);

  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('Watching for changes...');

  // Keep process alive
  process.on('SIGINT', async () => {
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    process.exit(0);
  });
}

// Run
if (isWatch) {
  watch();
} else {
  build();
}
