// A postcss-import fűzi be a tokens.css-t a Tailwind ELŐTT (ahogy a Vite tette):
// a Next a CSS @import-ot csak a PostCSS után oldaná fel, és akkor a tokens.css
// `@layer base` blokkja `@tailwind base` nélkül maradna.
export default {
  plugins: {
    "postcss-import": {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
