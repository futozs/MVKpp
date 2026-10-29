import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import mvkPreset from "./src/styles/tailwind-preset.mjs";

export default {
  presets: [mvkPreset],
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./src/**/*.{js,ts,jsx,tsx}"],
  plugins: [animate],
} satisfies Config;
