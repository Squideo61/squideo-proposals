// Build script for the Squideo Chrome extension.
//
// Chrome MV3 content scripts can't use ES module imports — they're injected
// as plain scripts. Vite's default code splitting creates shared chunks
// between entries, which breaks the content script with
// "Cannot use import statement outside a module".
//
// Fix: build each entry in its own Vite lib-mode invocation so each output
// is a fully self-contained IIFE bundle with no cross-entry imports. The
// popup is bundled the same way for consistency (even though popup.html
// could in principle load module scripts).

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dist = resolve(root, 'dist');

const COMMON_DEFINE = {
  'process.env.NODE_ENV': JSON.stringify('production'),
  'process.env.SQUIDEO_API_BASE': JSON.stringify('https://squideo-proposals-tu96.vercel.app'),
};

async function buildEntry({ name, input }) {
  await build({
    configFile: false,
    root,
    plugins: [react()],
    define: COMMON_DEFINE,
    build: {
      outDir: dist,
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      lib: {
        entry: input,
        name,
        formats: ['iife'],
        fileName: () => `${name}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          extend: true,
        },
      },
    },
  });
}

async function main() {
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  await buildEntry({ name: 'content',    input: resolve(root, 'src/content/index.jsx') });
  await buildEntry({ name: 'background', input: resolve(root, 'src/background.js') });
  await buildEntry({ name: 'popup',      input: resolve(root, 'src/popup.jsx') });

  // Static assets: manifest, popup html, icons.
  copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
  copyFileSync(join(root, 'public', 'popup.html'), join(dist, 'popup.html'));
  for (const file of readdirSync(join(root, 'public'))) {
    const full = join(root, 'public', file);
    if (statSync(full).isFile() && file.endsWith('.png')) {
      copyFileSync(full, join(dist, file));
    }
  }

  console.log('\nBuilt extension to', dist);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
