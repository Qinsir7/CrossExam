import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Match the production Vercel rewrite in local development. Browser x402
    // traffic stays same-origin, which avoids CORS/header interference and
    // makes the real production API testable without changing client code.
    proxy: {
      '/review-service': {
        target: 'https://api.cross-exam.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/review-service/, '/api'),
      },
    },
  },
})
