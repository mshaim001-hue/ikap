import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Приложение теперь разворачивается как обычный SPA на корне домена (Render / Docker),
  // поэтому base всегда '/' (GitHub Pages больше не используем).
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        secure: false,
        // Убеждаемся, что все методы (включая DELETE) проксируются
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, res) => {
            console.log('Proxy error:', err)
          })
        }
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})

