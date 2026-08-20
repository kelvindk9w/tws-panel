import { defineConfig } from "vitest/config";

// Cobertura focada na lógica pura (DNS, blacklist, credenciais, smtp-inject);
// client/server/exec falam com o Stalwart/Docker e são cobertos pelos E2E.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts", "src/client.ts", "src/server.ts", "src/exec.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 90, functions: 85, branches: 85, statements: 90 },
    },
  },
});
