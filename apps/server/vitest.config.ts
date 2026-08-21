import { defineConfig } from "vitest/config";

// Escopo de cobertura unitária: rotas, plugins e serviços com lógica de
// negócio testável sem Docker (auth, setup, projetos, alertas, auditoria,
// config, saúde da máquina — lida de verdade do host de teste).
//
// FORA do escopo unitário — cobertos pelos E2E (pnpm test:e2e), pois só
// falam com Docker/Stalwart/OS e mocká-los seria artificial:
//  - src/app.ts, src/index.ts (bootstrap/registro de plugins)
//  - src/routes/{docker,mail,monitoring,security}.ts (delegam aos serviços)
//  - src/services/{docker-service,deploy-service,mail-service,
//    monitor-service,security-service}.ts (engine/exec/runner de containers)
//  - src/services/docker-socket.ts (I/O crua com o docker.sock — validada por
//    smoke/E2E com Docker real) e src/services/terminal-runner.ts (wrapper
//    fino exercitado via terminal-service nos testes de rotas)
// terminal-service.ts ENTRA no escopo: a REGRA DE OURO (input nunca logado),
// o parse do marcador de exit e a fila de comandos são lógica pura testável.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/config.ts",
        "src/plugins/auth.ts",
        "src/routes/auth.ts",
        "src/routes/domains.ts",
        "src/routes/health.ts",
        "src/routes/projects.ts",
        "src/routes/setup.ts",
        "src/services/alerts-service.ts",
        "src/services/audit-service.ts",
        "src/services/login-limiter.ts",
        "src/services/password.ts",
        "src/services/session-store.ts",
        "src/services/setup-state.ts",
        "src/services/setup-token.ts",
        "src/services/system-info.ts",
        "src/services/terminal-service.ts",
        "src/services/user-store.ts",
      ],
      reporter: ["text", "html"],
      // atingido: ~97% linhas no escopo; residual = system-info (ramos que
      // dependem do hardware/SO do host) e defesas inalcançáveis pela API
      // pública (corrida admin_exists, sign antes de init)
      thresholds: { lines: 94, functions: 98, branches: 91, statements: 94 },
    },
  },
});
