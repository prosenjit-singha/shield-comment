import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Same-origin API (tech-stack.md §4): the browser calls /api on app.localhost:5174 and the dev server
// forwards it. Not a VITE_* var on purpose: only the dev server and the Start server read it.
const apiUpstream = process.env.API_UPSTREAM ?? 'http://localhost:3000'
const apiProxy = { '/api': { target: apiUpstream, changeOrigin: false, xfwd: true } }

// https://tanstack.com/start/latest/docs/framework/react/build-from-scratch
export default defineConfig({
  // Start must come before the React plugin. It turns on file routes in src/routes/ with autoCodeSplitting.
  plugins: [tanstackStart(), react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  // Open http://app.localhost:5174 (host-only session cookie). Keeps the browser's Host and adds X-Forwarded-*.
  server: { port: 5174, strictPort: true, host: true, proxy: apiProxy },
  preview: { port: 5174, strictPort: true, host: true, proxy: apiProxy },
})
