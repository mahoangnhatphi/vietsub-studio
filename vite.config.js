import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Works at both username.github.io/ and username.github.io/repository/.
  base: './',
  build: { outDir: 'web-dist', target: 'es2022' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@huggingface/transformers'] },
  plugins: [VitePWA({
    registerType: 'prompt',
    injectRegister: 'auto',
    manifest: false,
    workbox: {
      globPatterns: ['**/*.{html,js,css,wasm,mjs,ttf}'],
      maximumFileSizeToCacheInBytes: 60 * 1024 * 1024,
      navigateFallback: 'index.html',
      // Never swap workers while a video is being processed.
      skipWaiting: false,
      clientsClaim: true,
    },
  })],
});
