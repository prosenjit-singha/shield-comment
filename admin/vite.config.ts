import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Same-origin API (tech-stack.md §4): the browser calls /api on admin.localhost:5173 and Vite forwards it.
// Not a VITE_* var on purpose: it is only read by the dev server, never inlined into the bundle.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  // The router plugin must run before the React plugin.
  plugins: [
    // No code splitting under Vitest: a split route component is a lazy import that Vite transforms
    // on first render, which under load outlasted the 1 s `findBy*` window of each test file's first
    // test (flaky shell/login/dashboard/system tests). Eager components load with the route tree at
    // file import time instead, which has no timeout. Dev and production builds still split.
    tanstackRouter({ target: 'react', autoCodeSplitting: !process.env.VITEST }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    // Keep the browser's Host (admin.localhost:5173) and add X-Forwarded-For/Host/Proto/Port.
    proxy: { '/api': { target: apiTarget, changeOrigin: false, xfwd: true } },
  },
  preview: {
    port: 5173,
    strictPort: true,
    host: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false, xfwd: true } },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
