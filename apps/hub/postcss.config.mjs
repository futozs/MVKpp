// A postcss-import fűzi be a web tokens.css-ét a Tailwind ELŐTT (ugyanúgy, mint a főappban).
export default {
  plugins: {
    "postcss-import": {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
