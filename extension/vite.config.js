import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// We need three independent JS bundles:
//   - content.js: injected into mail.google.com (uses InboxSDK)
//   - background.js: service worker (token storage, message bus)
//   - popup.js: extension toolbar popup (auth status)
// And we need manifest.json + the popup HTML + icons copied to dist/ so
// Chrome can load the folder unpacked.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const root = resolve(__dirname);
        const dist = resolve(__dirname, 'dist');
        if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
        // manifest
        copyFileSync(join(root, 'manifest.json'), join(dist, 'manifest.json'));
        // popup
        copyFileSync(join(root, 'public', 'popup.html'), join(dist, 'popup.html'));
        // icons (any *.png in public/)
        for (const file of readdirSync(join(root, 'public'))) {
          const full = join(root, 'public', file);
          if (statSync(full).isFile() && file.endsWith('.png')) {
            copyFileSync(full, join(dist, file));
          }
        }
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'src/content/index.jsx'),
        background: resolve(__dirname, 'src/background.js'),
        popup: resolve(__dirname, 'src/popup.jsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
        // Inline everything into the entry chunks so Chrome doesn't have to
        // resolve relative imports at runtime inside the content script.
        inlineDynamicImports: false,
        manualChunks: undefined,
      },
    },
    target: 'es2022',
    minify: false, // keep readable for early dev; turn on for the Web Store build
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.SQUIDEO_API_BASE': JSON.stringify('https://squideo-proposals-tu96.vercel.app'),
  },
});
