import { defineConfig } from 'vite'
// @ts-expect-error — megosztott .mjs konfig a projekt gyokereben
import { serverConfig } from '../vite.shared.mjs'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ command }) => ({
  // Buildkor a gateway a /hub utvonalon szolgalja ki, ezert az eszkoz-hivatkozasoknak
  // is oda kell mutatniuk. Dev modban a sajat portjan (5174) a gyokeren marad.
  base: command === 'build' ? '/hub/' : '/',
  plugins: [react()],
  resolve: {
    // A megosztott primitívek az app gyökerén kívül élnek; enélkül
    // két React-példány kerülhetne a bundle-be, és a hookok elszállnának.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: serverConfig(5174),
}))
