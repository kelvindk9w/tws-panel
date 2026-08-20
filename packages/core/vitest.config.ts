import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "html"],
      thresholds: { lines: 98, functions: 98, branches: 98, statements: 98 },
    },
  },
});
