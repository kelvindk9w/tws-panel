/**
 * project-logs.ts — funções puras da aba Logs do projeto.
 */
import type { ProjectLogLine, ProjectLogService } from "@paas/core";
import { formatTime, lowerCase } from "@/i18n";

/** Linhas que contêm o texto (no texto da linha ou no nome do serviço), sem diferenciar maiúsculas. */
export function filterLogLines(lines: ProjectLogLine[], query: string): ProjectLogLine[] {
  const q = lowerCase(query.trim());
  if (q === "") return lines;
  return lines.filter((l) => lowerCase(l.text).includes(q) || lowerCase(l.service).includes(q));
}

/** Texto para a área de transferência: uma linha por linha do log. */
export function linesToText(lines: ProjectLogLine[]): string {
  return lines
    .map((l) => [l.time, l.service, l.stream === "stderr" ? "[stderr]" : null, l.text].filter((p) => p !== null && p !== "").join(" "))
    .join("\n");
}

/** A rolagem está no fim (ou a poucos pixels dele)? */
export function isNearBottom(el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

/** "14:05:09" no fuso do navegador; vazio sem horário. */
export function logTimeLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatTime(d, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Há serviços e nenhum está de pé (reiniciando conta como de pé: está em ciclo de falha, não parado). */
export function isProjectStopped(services: ProjectLogService[]): boolean {
  return services.length > 0 && services.every((s) => s.state !== "running" && s.state !== "restarting");
}
