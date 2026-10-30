/**
 * server-logs.ts — página "Logs do servidor" (GET /api/server-logs): o que os containers do PRÓPRIO painel
 * (painel, proxy, servidor de e-mail) e duas unidades do host (Docker e SSH) escrevem. Somente leitura, só sessão.
 *
 * As fontes são uma lista FECHADA: o pedido escolhe um id desta lista, nunca informa nome de container nem de
 * unidade. O formato da resposta é o mesmo da aba Logs do projeto (project-logs.ts): `service` é o id da fonte.
 */
import type { ProjectLogsResponse, ProjectLogsSince } from "./project-logs";

export const SERVER_LOG_SOURCES = [
  { id: "panel", kind: "container", container: "tws-panel" },
  { id: "proxy", kind: "container", container: "paas-caddy" },
  { id: "mail", kind: "container", container: "paas-stalwart" },
  { id: "docker", kind: "journal", container: null },
  { id: "ssh", kind: "journal", container: null },
] as const;

export type ServerLogSourceId = (typeof SERVER_LOG_SOURCES)[number]["id"];

export const SERVER_LOG_SOURCE_IDS: readonly ServerLogSourceId[] = SERVER_LOG_SOURCES.map((s) => s.id);

/** Linhas das unidades do host (journal) por pedido. */
export const SERVER_LOGS_JOURNAL_TAIL_MAX = 2000;

export type ServerLogsSince = ProjectLogsSince;

/** A resposta é a da aba Logs do projeto; `services[].service` e `lines[].service` são ids de fonte. */
export type ServerLogsResponse = ProjectLogsResponse;
