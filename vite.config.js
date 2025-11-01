import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Для GitHub Pages нужно указать base path репозитория
  // Если репозиторий называется "ikap", то base: '/ikap/'
  // Если репозиторий username.github.io, то base: '/'
  base: process.env.VITE_BASE_PATH || '/ikap/',
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})

