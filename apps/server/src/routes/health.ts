import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { scanSystemHealth, type HostProbe } from "../services/system-info.js";
import { TerminalUnavailableError } from "../services/terminal-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

/**
 * Varredura de saúde da máquina + espelho de transparência no terminal web.
 *
 * Origem dos dados (ver system-info.ts):
 *  - o que o kernel compartilha com o container (CPU, carga, memória, uptime,
 *    DMI) e os metadados montados em /host/etc são lidos direto pelo Node;
 *  - o que o container NÃO enxerga — interfaces de rede da VPS e o marcador
 *    de reinicialização pendente — é lido NO HOST por dois comandos fixos e
 *    somente-leitura, executados pelo terminal do servidor (helper nsenter no
 *    PID 1 do host). Só quando o alvo configurado é o próprio host
 *    (PAAS_TARGET=host): em qualquer outro alvo, ou se o terminal não abrir,
 *    esses itens saem como "não verificado".
 *
 * Os demais comandos (cabeçalho, os-release, free, df...) são o ESPELHO: rodam
 * de verdade no terminal para o usuário acompanhar, sem alimentar os cards.
 * Se o terminal estiver indisponível o espelho é pulado em silêncio.
 */
const HEALTH_MIRROR_HEADER =
  "printf '\\n\\033[1;34m── 🩺 Varredura de saúde da máquina (somente leitura) ──\\033[0m\\n'";

const HEALTH_MIRROR_COMMANDS: readonly string[] = [
  "cat /etc/os-release | grep -E '^(PRETTY_NAME|VERSION)='",
  "hostname && uname -srm",
  "nproc && cat /proc/loadavg",
  "free -h",
  "df -h /",
  "uptime",
];

/** Tempo máximo de cada leitura no host (inclui abrir o terminal, se preciso). */
export const HOST_PROBE_TIMEOUT_MS = 20_000;

function hostProbeFor(app: FastifyInstance): HostProbe | undefined {
  if (!app.hasDecorator("terminalService") || !app.hasDecorator("config")) return undefined;
  if (app.config.securityTarget !== "host") return undefined;
  const terminal = app.terminalService;
  return (cmd) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("leitura do host excedeu o tempo limite")), HOST_PROBE_TIMEOUT_MS);
    });
    return Promise.race([terminal.runCommandCaptured(cmd, { timeoutMs: HOST_PROBE_TIMEOUT_MS }), timeout]).finally(
      () => clearTimeout(timer),
    );
  };
}

const healthRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  // Nenhuma das duas rotas abaixo recebe entrada do cliente — o handler
  // acima só padroniza o formato de erro caso algo inesperado aconteça.
  // Liveness público (sem auth) — usado pelo HEALTHCHECK do Docker e por
  // balanceadores/monitoramento externos.
  app.get("/api/healthz", async () => ({ status: "ok" }));

  app.get("/api/health/scan", async (_request, reply) => {
    const runMirror = (cmd: string) => app.terminalService.runCommand(cmd, () => undefined, { timeoutMs: 15_000 });
    const onMirrorError = (err: unknown) => {
      if (!(err instanceof TerminalUnavailableError)) {
        app.log.warn({ err }, "espelho da varredura de saúde no terminal falhou");
      }
    };

    // O cabeçalho entra na fila do terminal ANTES das leituras no host, para
    // o usuário ver o título e depois cada comando rodando.
    const header = (async () => runMirror(HEALTH_MIRROR_HEADER))().then(
      () => true,
      (err: unknown) => {
        onMirrorError(err);
        return false;
      },
    );

    const result = await scanSystemHealth({ hostProbe: hostProbeFor(app) });

    // Espelho no terminal (fire-and-forget): nunca atrasa nem derruba o scan.
    void (async () => {
      if (!(await header)) return;
      try {
        for (const cmd of HEALTH_MIRROR_COMMANDS) {
          await runMirror(cmd);
        }
      } catch (err) {
        onMirrorError(err);
      }
    })();

    return reply.send(result);
  });
};

export default healthRoutes;
