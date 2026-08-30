import { defineConfig } from 'vite'
// @ts-expect-error — megosztott .mjs konfig a projekt gyokereben
import { serverConfig } from '../vite.shared.mjs'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    ...serverConfig(5173),
    allowedHosts: ['localhost', '127.0.0.1', 'mvk.futozs.hu'],
  },
  resolve: {
    // A megosztott primitívek az app gyökerén kívül élnek; enélkül
    // két React-példány kerülhetne a bundle-be, és a hookok elszállnának.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
