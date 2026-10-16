import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { API_ROUTES } from './api-routes.mjs'

// Neither API allows browser requests (no CORS headers), so proxy them.
// Matched as whole paths (a plain key would match as a prefix: /api/metar would take /api/metar-area).
const apiProxy: Record<string, ProxyOptions> = Object.fromEntries(
  Object.entries(API_ROUTES).map(([path, route]) => [
    `^${path}(\\?|$)`,
    { target: route.target, changeOrigin: true, rewrite: (p: string) => route.rewrite(p) ?? '/invalid' },
  ]),
)

/** The commit this is built from, to tell builds apart (Settings › General › Updates). */
function commit() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: { __BUILD__: JSON.stringify({ commit: commit(), time: new Date().toISOString() }) },
  // The parent folder too, for CHANGELOG.md at the repo root (src/utils/changelog.ts).
  server: { proxy: apiProxy, fs: { allow: ['..'] } },
  preview: { proxy: apiProxy },
})
