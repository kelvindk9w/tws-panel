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
      //
      // functions recalibrado de 98 para 97,5 na migração para o Vitest 4
      // (medido: 97,77% = 44/45). A v4 remapeia a cobertura pelo AST e passa a
      // contar como função os callbacks inline defensivos que a v3 ignorava
      // (com o mesmo código a v3 media 100%). A única função descoberta é um
      // no-op defensivo sem comportamento observável a testar:
      //  - src/detect.ts:64 — readdir(dir).catch(() => []): o diretório do
      //    projeto acabou de ser lido (package.json) na mesma chamada; só
      //    falharia com uma pasta atravessável mas não listável.
      // Os demais callbacks defensivos de detect.ts (next.config e Dockerfile
      // ilegíveis) são cobertos por teste, pois mudam o resultado da detecção.
      thresholds: { lines: 97, functions: 97.5, branches: 95, statements: 97 },
    },
  },
});
