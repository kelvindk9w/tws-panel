/**
 * container-log-limits.ts — aviso da subida sobre o limite do log dos containers.
 *
 * O limite (json-file com rotação, ver container-logs.ts do core) só vale para
 * container criado ou recriado depois da atualização: o Docker não muda o log
 * de um container que já existe. Na subida o painel confere quem ainda está
 * sem ele e diz isso no log do servidor, sem recriar nada:
 *  - Caddy e Stalwart: recriar derrubaria todos os sites (portas 80/443 e o IP
 *    fixo em cada rede do proxy) ou o e-mail por alguns segundos — fica para o
 *    operador escolher a hora;
 *  - o container do painel: ganha o limite no `docker compose up -d` da atualização;
 *  - containers dos projetos: ganham no próximo deploy (ou Recriar, menos o site estático) de cada um; o serviço
 *    cujo compose declara `logging:` próprio leva a label tws.log.own e não é acusado (a escolha é do projeto).
 * O webmail não entra no aviso: o próprio painel o troca com segurança ao subi-lo (webmail.ts).
 */
import {
  PAAS_CADDY_CONTAINER,
  PAAS_LABEL_MANAGED,
  PAAS_STALWART_CONTAINER,
  PAAS_WEBMAIL_CONTAINER,
  TWS_LABEL_LOG_OWN,
  containerLogLimits,
  isUnboundedLogConfig,
  type ContainerLogLimits,
} from "@paas/core";

type RunFn = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Containers do próprio painel que só o operador recria (ver o cabeçalho). */
const OWN_CONTAINERS = [PAAS_CADDY_CONTAINER, PAAS_STALWART_CONTAINER] as const;

export interface LogLimitsReport {
  /** Caddy/Stalwart sem o limite. */
  own: string[];
  /** O container do painel está sem o limite. */
  panel: boolean;
  /** Containers dos projetos (label do painel) sem o limite. */
  projects: string[];
}

/** Quem ainda está sem o limite. Falha do Docker: relatório vazio (o aviso é só informação). */
export async function containersWithoutLogLimits(run: RunFn, panelContainer: string, limits: ContainerLogLimits | null = containerLogLimits()): Promise<LogLimitsReport> {
  const empty: LogLimitsReport = { own: [], panel: false, projects: [] };
  if (!limits) return empty;
  const ls = await run("docker", ["ps", "-aq"]);
  const ids = ls.code === 0 ? ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  if (ids.length === 0) return empty;
  const template = `{{.Name}}|{{index .Config.Labels "${PAAS_LABEL_MANAGED}"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "${TWS_LABEL_LOG_OWN}"}}|{{json .HostConfig.LogConfig}}`;
  const inspect = await run("docker", ["inspect", "-f", template, ...ids]);
  // um container que sumiu entre o ps e o inspect só falta na saída
  if (inspect.code !== 0 && !inspect.stdout.trim()) return empty;
  const report: LogLimitsReport = { own: [], panel: false, projects: [] };
  for (const line of inspect.stdout.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const name = parts[0]!.replace(/^\//, "");
    if (!isUnboundedLogConfig(parts.slice(4).join("|"))) continue;
    // serviço cujo compose declara logging: próprio (label do deploy): a escolha é do projeto, não é "sem limite"
    if (parts[3] === "true") continue;
    // do painel: o dele, o Caddy/Stalwart, os criados com a label do painel e os do compose de um projeto (paas-<slug>)
    if (name === panelContainer) report.panel = true;
    else if ((OWN_CONTAINERS as readonly string[]).includes(name)) report.own.push(name);
    else if (name !== PAAS_WEBMAIL_CONTAINER && (parts[1] === "true" || parts[2]!.startsWith("paas-"))) report.projects.push(name);
  }
  return report;
}

/** Linhas do aviso (vazio = nada a dizer). */
export function logLimitsWarnings(report: LogLimitsReport): string[] {
  const out: string[] = [];
  if (report.own.length > 0) {
    out.push(
      `Limite do log: ${report.own.join(", ")} foi(ram) criado(s) antes do limite e segue(m) com o log sem teto até ser(em) recriado(s). ` +
        "O painel não os recria sozinho (derrubaria os sites ou o e-mail por alguns segundos); veja comoFuncionaSistema/docker/conceito-limite-de-log.json para fazer numa janela de manutenção.",
    );
  }
  if (report.panel) {
    out.push("Limite do log: o container do painel foi criado sem o limite; ele passa a valer no próximo `docker compose up -d` da instalação (o da atualização).");
  }
  if (report.projects.length > 0) {
    const shown = report.projects.slice(0, 10).join(", ");
    const more = report.projects.length > 10 ? ` e mais ${report.projects.length - 10}` : "";
    out.push(
      `Limite do log: ${report.projects.length} container(s) de projeto ainda sem o limite (${shown}${more}); cada um ganha no próximo deploy do projeto (ou Recriar, menos site estático, que só no deploy). ` +
        "Serviço cujo compose declara logging: próprio é respeitado e sai desta lista depois do próximo deploy.",
    );
  }
  return out;
}
