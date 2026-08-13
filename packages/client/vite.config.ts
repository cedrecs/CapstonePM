import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev proxy: the SPA runs on 5173; API, auth, and WS are served by the
// backend on 3000. In production the server serves the built SPA itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
})
