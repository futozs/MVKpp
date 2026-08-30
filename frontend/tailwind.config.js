import animate from "tailwindcss-animate";
import mvkPreset from "../theme/tailwind-preset.js";

export default {
  presets: [mvkPreset],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  plugins: [animate],
};
