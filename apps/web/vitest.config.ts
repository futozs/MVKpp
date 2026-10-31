import path from "node:path";
import { defineConfig } from "vitest/config";

// A `@/…` importok (mint a Next-ben) a tesztekben is a src-re mutatnak.
export default defineConfig({
  resolve: { alias: { "@": path.join(__dirname, "src") } },
  test: { include: ["test/**/*.test.ts"] },
});
