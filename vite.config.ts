import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { BASE_PATH } from './src/shared/base';

export default defineConfig({
  plugins: [react(), cloudflare()],
  // The site is served below BASE_PATH on a shared host. Built files go to
  // dist/client/ai-news/assets and public files live in public/ai-news, so static asset
  // paths carry the prefix on disk. index.html stays at the root, where the
  // single-page-application fallback looks for it.
  environments: {
    client: { build: { assetsDir: `${BASE_PATH.slice(1)}/assets` } },
  },
});
