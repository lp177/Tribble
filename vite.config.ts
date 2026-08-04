import { defineConfig } from 'vite'

// GitHub Pages serves this repo from /Tribble/ (project pages), so all asset
// URLs must be relative. The production build is committed under docs/.
export default defineConfig({
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
  },
})
