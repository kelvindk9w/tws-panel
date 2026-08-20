import { defineConfig } from "vitest/config";

// Cobertura focada na lógica pura (checks/planner/baseline); executor,
// monitor, runner e scanner executam comandos no alvo e são cobertos pelos E2E.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/index.ts", "src/executor.ts", "src/monitor.ts", "src/runner.ts", "src/scanner.ts"],
      reporter: ["text", "html"],
      // atingido: 100% linhas/funções; branches residuais são defesas mortas
      // (ex.: `?? ""` após índice sempre definido, braço inalcançável de cond)
      thresholds: { lines: 98, functions: 98, branches: 96, statements: 98 },
    },
  },
});
