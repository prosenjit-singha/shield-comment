import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://tanstack.com/start/latest/docs/framework/react/build-from-scratch
export default defineConfig(({ mode }) => {
  // Server-side keys (API_UPSTREAM, PUBLIC_SITE_URL, FORWARDED_FOR_MODE) are never VITE_* (never inlined):
  // the dev server and SSR code read process.env, so fill it from Vite's env files
  // (.env.[mode].local > .env.[mode] > .env.local > .env); variables already set always win.
  for (const [key, value] of Object.entries(loadEnv(mode, import.meta.dirname, ''))) process.env[key] ??= value
  // Same-origin API (tech-stack.md §4): the browser calls /api on app.localhost:5174 and the dev server forwards it.
  const apiUpstream = process.env.API_UPSTREAM ?? 'http://localhost:3000'
  const apiProxy = { '/api': { target: apiUpstream, changeOrigin: false, xfwd: true } }
  return {
    // Start must come before the React plugin. It turns on file routes in src/routes/ with autoCodeSplitting.
    plugins: [tanstackStart(), react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    // Open http://app.localhost:5174 (host-only session cookie). Keeps the browser's Host and adds X-Forwarded-*.
    server: { port: 5174, strictPort: true, host: true, proxy: apiProxy },
    preview: { port: 5174, strictPort: true, host: true, proxy: apiProxy },
  }
})
