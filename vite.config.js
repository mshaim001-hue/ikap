import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Для GitHub Pages нужно указать base path репозитория
  // Если репозиторий называется "ikap", то base: '/ikap/'
  // Если репозиторий username.github.io, то base: '/'
  base: process.env.VITE_BASE_PATH || (process.env.NODE_ENV === 'production' ? '/ikap/' : '/'),
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

