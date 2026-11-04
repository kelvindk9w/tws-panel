/**
 * server-logs.ts — funções puras da página "Logs do servidor".
 */
import { SERVER_LOG_SOURCES, type ProjectLogService, type ServerLogSourceId } from "@paas/core";
import type { Key } from "@/i18n";

export const SOURCE_LABEL_KEYS: Record<ServerLogSourceId, Key> = {
  panel: "diagnostico.serverLogs.source.panel",
  proxy: "diagnostico.serverLogs.source.proxy",
  mail: "diagnostico.serverLogs.source.mail",
  docker: "diagnostico.serverLogs.source.docker",
  ssh: "diagnostico.serverLogs.source.ssh",
};

/** Fonte conhecida (a lista é fechada). */
export function isSourceId(id: string): id is ServerLogSourceId {
  return SERVER_LOG_SOURCES.some((s) => s.id === id);
}

/** Texto da fonte; id desconhecido volta como veio. */
export function sourceLabelKey(id: string): Key | null {
  return isSourceId(id) ? SOURCE_LABEL_KEYS[id] : null;
}

/** Fonte lida do journal do host (Docker e SSH da VPS). */
export function isJournalSource(id: string): boolean {
  return SERVER_LOG_SOURCES.some((s) => s.id === id && s.kind === "journal");
}

/** Query do pedido: só envia o que foi escolhido. */
export function buildServerLogsQuery(opts: { source: string; tail: number; since: string }): string {
  const qs = new URLSearchParams({ tail: String(opts.tail) });
  if (opts.source) qs.set("source", opts.source);
  if (opts.since) qs.set("since", opts.since);
  return qs.toString();
}

/** Chave de tradução do erro devolvido pela API (código no corpo ou 429 do limitador). */
export function serverLogsErrorKey(code: string, status: number): Key {
  switch (code) {
    case "docker_unavailable":
      return "diagnostico.serverLogs.error.docker";
    case "log_masking_unavailable":
      return "diagnostico.serverLogs.error.masking";
    case "logs_busy":
      return "diagnostico.serverLogs.error.busy";
    case "source_not_found":
      return "diagnostico.serverLogs.error.notFound";
    case "invalid_source":
    case "invalid_log_query":
    case "invalid_request":
      return "diagnostico.serverLogs.error.invalid";
    default:
      return status === 429 ? "diagnostico.serverLogs.error.rate" : "diagnostico.serverLogs.error.load";
  }
}

/** Alguma fonte do journal veio sem leitura porque a ponte do host não existe aqui. */
export function hasJournalUnavailable(services: ProjectLogService[]): boolean {
  return services.some((s) => isJournalSource(s.service) && s.logsError === "unavailable");
}
