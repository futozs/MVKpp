import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
// Ugyanaz a téma, mint a főappé: a tokenek és a preset a web alól jönnek.
import mvkPreset from "../web/src/styles/tailwind-preset.mjs";

export default {
  presets: [mvkPreset],
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  plugins: [animate],
} satisfies Config;
