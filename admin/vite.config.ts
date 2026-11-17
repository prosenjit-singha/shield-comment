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
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
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
  },
})
