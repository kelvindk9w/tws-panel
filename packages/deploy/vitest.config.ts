import { defineConfig } from "vitest/config";

// Cobertura focada na lógica pura (detect/guardrails/rules); engine, caddy,
// exec e ingest dependem de Docker e são cobertos pelos E2E (pnpm test:e2e).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts", "src/engine.ts", "src/caddy.ts", "src/exec.ts", "src/ingest.ts"],
      reporter: ["text", "html"],
      // atingido: ~99,5% linhas; o residual são catches defensivos de TOCTOU
      // (stat/readFile falhando entre readdir e leitura) e branches mortas
      thresholds: { lines: 97, functions: 98, branches: 95, statements: 97 },
    },
  },
});
