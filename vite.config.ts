import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict renderer CSP, injected into the built index.html only (WP-7.3).
// It is intentionally absent in `vite dev` so the Vite dev client/HMR works; production builds and
// the packaged app load the CSP-protected document (verified by `--uitest` against dist/).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.modrinth.com https://api.curseforge.com https://piston-meta.mojang.com https://meta.fabricmc.net https://files.minecraftforge.net https://maven.neoforged.net https://fill.papermc.io https://api.adoptium.net https://api.mojang.com",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Frame-ancestors is omitted: browsers ignore it in <meta>; embedding is prevented by the app's
// file://-only window plus the main-process navigation/window-open hardening. Add it as an HTTP
// response header if an HTTP origin is ever introduced.

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'inject-build-csp',
      apply: 'build',
      transformIndexHtml(html: string) {
        return html.replace(
          '</head>',
          `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
        );
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2020',
  },
});
