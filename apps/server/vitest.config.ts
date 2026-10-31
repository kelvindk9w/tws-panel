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
//  - src/services/onboarding-sources.ts (estado do e-mail: consulta o Docker
//    como mail-service.ts; a regra do passo fica em onboarding.ts, coberta)
//  - src/services/mail-test-docker.ts (comandos do Mailpit pelo docker CLI; o teste mail-test-docker.test.ts
//    confere cada comando com um dublê de `run`, mas a cobertura não o mede, como backup-docker.ts)
//  - src/services/backup-docker.ts (dump dos bancos, cópia de volumes e pausa
//    do e-mail pelo docker CLI — validado no E2E real descrito em
//    relatório interno backups; o serviço usa um dublê)
//  - src/services/database-docker.ts (o `docker exec` da aba Banco, com o SQL na entrada padrão; o
//    serviço database-service.ts usa um dublê e é coberto)
//  - src/services/docker-socket.ts (I/O crua com o docker.sock — validada por
//    smoke/E2E com Docker real) e src/services/terminal-runner.ts (wrapper
//    fino exercitado via terminal-service nos testes de rotas)
// terminal-service.ts ENTRA no escopo: a REGRA DE OURO (input nunca logado),
// o parse do marcador de exit e a fila de comandos são lógica pura testável.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // O padrão de 5 s vale para a máquina ociosa. Com o pre-push, o CI ou o computador ocupado rodando a suíte em paralelo,
    // o primeiro import do app, um buildApp ou um WebSocket real passam disso sem que nada esteja errado.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["tests/setup-git-env.ts", "tests/setup-no-docker.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/config.ts",
        "src/log-config.ts",
        "src/plugins/auth.ts",
        "src/routes/auth.ts",
        "src/routes/access.ts",
        "src/routes/email-code.ts",
        "src/routes/api-tokens.ts",
        "src/routes/backups.ts",
        "src/routes/upload-restore.ts",
        "src/routes/cloudflare.ts",
        "src/services/cloudflare-dns.ts",
        "src/routes/domains.ts",
        "src/routes/dynamic-domains.ts",
        "src/routes/health.ts",
        "src/routes/mail-envios.ts",
        "src/routes/mcp.ts",
        "src/routes/mcp-admin.ts",
        "src/routes/mail-health.ts",
        "src/routes/mail-test.ts",
        "src/routes/notifications.ts",
        "src/routes/onboarding.ts",
        "src/routes/panel-domain.ts",
        "src/routes/projects.ts",
        "src/routes/project-logs.ts",
        "src/routes/server-logs.ts",
        "src/routes/mail-diagnosis-routes.ts",
        "src/routes/project-database.ts",
        "src/services/database-service.ts",
        "src/services/database-sql.ts",
        "src/services/update-check-service.ts",
        "src/services/proxy-network.ts",
        "src/routes/restore-reconciliation.ts",
        "src/routes/setup.ts",
        "src/routes/timezone.ts",
        "src/services/access-service.ts",
        "src/services/email-code.ts",
        "src/services/alerts-service.ts",
        "src/services/api-token-store.ts",
        "src/services/audit-service.ts",
        "src/services/backup-archive.ts",
        "src/services/confirm-identity.ts",
        "src/services/backup-detect.ts",
        "src/services/backup-passphrase.ts",
        "src/services/backup-s3.ts",
        "src/services/backup-schedule.ts",
        "src/services/backup-service.ts",
        "src/services/upload-restore.ts",
        "src/services/upload-restore-format.ts",
        "src/services/host-timezone.ts",
        "src/services/json-file.ts",
        "src/services/docker-logs.ts",
        "src/services/dynamic-ask-server.ts",
        "src/services/dynamic-dns-check.ts",
        "src/services/dynamic-domains.ts",
        "src/services/log-mask.ts",
        "src/services/project-logs.ts",
        "src/services/server-logs.ts",
        "src/services/mail-refusal-store.ts",
        "src/services/mail-hints.ts",
        "src/services/mail-diagnosis-service.ts",
        "src/services/mail-probe-service.ts",
        "src/services/panel-secrets.ts",
        "src/services/mail-networks.ts",
        "src/services/login-limiter.ts",
        "src/services/mail-envios-service.ts",
        "src/services/mcp-approvals.ts",
        "src/services/mcp-protocol.ts",
        "src/services/mcp-settings.ts",
        "src/services/mcp-tools.ts",
        "src/services/mcp-validate.ts",
        "src/services/metrics-parse.ts",
        "src/services/metrics-compute.ts",
        "src/services/metrics-series.ts",
        "src/services/metrics-levels.ts",
        "src/services/metrics-store.ts",
        "src/services/metrics-settings.ts",
        "src/services/metrics-sources.ts",
        "src/services/metrics-docker.ts",
        "src/services/metrics-collector.ts",
        "src/services/metrics-query.ts",
        "src/services/metrics-watch.ts",
        "src/services/metrics-service.ts",
        "src/services/metrics-startup.ts",
        "src/services/deploy-jobs.ts",
        "src/routes/metrics.ts",
        "src/services/mail-health-service.ts",
        "src/services/mail-test-client.ts",
        "src/services/mail-test-html.ts",
        "src/services/mail-test-service.ts",
        "src/services/mail-test-scan.ts",
        "src/services/mail-reputation-service.ts",
        "src/services/notification-service.ts",
        "src/services/notification-sources.ts",
        "src/services/onboarding.ts",
        "src/services/panel-domain.ts",
        "src/services/panel-restore.ts",
        "src/services/password.ts",
        "src/services/port-map.ts",
        "src/services/reach-masks.ts",
        "src/services/request-reach.ts",
        "src/services/request-actor.ts",
        "src/services/restore-reconciliation.ts",
        "src/services/same-origin.ts",
        "src/services/session-store.ts",
        "src/services/setup-state.ts",
        "src/services/setup-token.ts",
        "src/services/stalwart-logs.ts",
        "src/services/system-info.ts",
        "src/services/telegram-client.ts",
        "src/services/terminal-service.ts",
        "src/services/timezone-service.ts",
        "src/services/token-policy.ts",
        "src/services/token-policy-table.ts",
        "src/services/user-store.ts",
      ],
      reporter: ["text", "html"],
      // Residual (medido no Vitest 4, que conta ramos e callbacks defensivos
      // que a v3 ignorava): defesas inalcançáveis pela API pública — checagens
      // de tipo que o schema do Fastify já barra (routes/auth.ts, routes/setup.ts)
      // e sign() antes de init() em session-store. A corrida admin_exists NÃO é
      // mais residual: é alcançável com requisições concorrentes e tem teste.
      thresholds: { lines: 94, functions: 98, branches: 91, statements: 94 },
    },
  },
});
