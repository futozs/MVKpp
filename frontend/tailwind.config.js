import animate from 'tailwindcss-animate'
import mvkPreset from '../theme/tailwind-preset.js'

/** @type {import('tailwindcss').Config} */
export default {
  presets: [mvkPreset],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // A preset a repo gyökerében él, onnan nem oldható fel a plugin —
  // ezért itt, az app gyökerén adjuk hozzá.
  plugins: [animate],
}
