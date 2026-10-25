import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri-ready: dev server port fixed so tauri.conf.json can target it later.
export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
});
