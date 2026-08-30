import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // A megosztott primitívek az app gyökerén kívül élnek; enélkül
    // két React-példány kerülhetne a bundle-be, és a hookok elszállnának.
    dedupe: ['react', 'react-dom'],
    alias: {
      // Design rendszer primitívek. A színek/tipográfia/ritmus a
      // megosztott theme/tokens.css-ből jön, nem innen.
      '@ui': fileURLToPath(new URL('./src/components/ui', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/live': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/gtfs': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/_health': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/_jwt': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/_export': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/_ingest': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/_renew': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
      '/system': {
        target: 'http://localhost:8088',
        changeOrigin: true,
      },
    },
  },
})
