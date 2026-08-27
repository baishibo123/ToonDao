import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Per-file environment is declared with a `@vitest-environment` docblock.
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
