import type { FastifyPluginAsync } from "fastify";
import { scanSystemHealth } from "../services/system-info.js";
import { TerminalUnavailableError } from "../services/terminal-service.js";

/**
 * Espelho de transparência da varredura de saúde no terminal web embutido.
 *
 * O resultado AUTORITATIVO dos cards vem de leituras do módulo `os` do Node e
 * de arquivos em /proc, /sys e /etc (sem shell — ver system-info.ts). Para o
 * usuário ACOMPANHAR a varredura ao vivo (feedback de campo), os comandos
 * equivalentes — todos FIXOS e somente-leitura — são executados de verdade no
 * terminal do servidor: a saída rola no xterm enquanto os cards são montados.
 *
 * Se o terminal estiver indisponível (ex.: docker.sock ausente em testes), o
 * espelho é simplesmente pulado — a varredura formatada nunca é bloqueada.
 */
const HEALTH_MIRROR_COMMANDS: readonly string[] = [
  "printf '\\n\\033[1;34m── 🩺 Varredura de saúde da máquina (somente leitura) ──\\033[0m\\n'",
  "cat /etc/os-release | grep -E '^(PRETTY_NAME|VERSION)='",
  "hostname && uname -srm",
  "nproc && cat /proc/loadavg",
  "free -h",
  "df -h /",
  "uptime",
  "ip -o -4 addr show scope global 2>/dev/null | head -5",
];

const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness público (sem auth) — usado pelo HEALTHCHECK do Docker e por
  // balanceadores/monitoramento externos.
  app.get("/api/healthz", async () => ({ status: "ok" }));

  app.get("/api/health/scan", async (_request, reply) => {
    const result = await scanSystemHealth();

    // Espelho no terminal (fire-and-forget): nunca atrasa nem derruba o scan.
    void (async () => {
      try {
        for (const cmd of HEALTH_MIRROR_COMMANDS) {
          await app.terminalService.runCommand(cmd, () => undefined, { timeoutMs: 15_000 });
        }
      } catch (err) {
        if (!(err instanceof TerminalUnavailableError)) {
          app.log.warn({ err }, "espelho da varredura de saúde no terminal falhou");
        }
      }
    })();

    return reply.send(result);
  });
};

export default healthRoutes;
