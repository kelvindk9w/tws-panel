/**
 * aof-diagnosis.ts — por que o redis do projeto reinicia sem parar: o arquivo AOF com o final corrompido.
 *
 * Roda a cada volta do coletor de métricas, ANTES do vigia de alertas (o alerta "reinicia sem parar" já nasce
 * com a causa). Só olha containers de projeto que estão em ciclo de reinício (estado "restarting" ou mais de 3
 * reinícios em 15 minutos, a mesma regra do semáforo): para eles lê as últimas linhas do log e procura a
 * mensagem de carga do AOF que falhou (@paas/core redis-aof.ts). Container fora do ciclo, ou que sumiu, sai da
 * lista; leitura de log que falhou mantém o que já se sabia.
 *
 * Nunca lança e nunca age: só diz a causa. O reparo é um clique da pessoa (aof-repair.ts).
 */
import { detectAofCorruption, type AofCorruption, type ProjectAofFinding } from "@paas/core";
import { demuxLogStream, splitTimestamp, type ContainerRuntime, type DockerLogsResult } from "./docker-logs.js";
import { stripLogControl } from "./log-mask.js";
import { problemReasons, type ContainerStatus, type TickResult } from "./metrics-collector.js";

/** Linhas do fim do log lidas de cada container em ciclo. */
export const AOF_LOG_TAIL = 300;
/** Containers em ciclo examinados por volta (o resto espera a próxima). */
export const AOF_MAX_PER_TICK = 8;
/** Teto de bytes e prazo de cada leitura de log. */
export const AOF_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const AOF_LOG_TIMEOUT_MS = 5_000;

/** Linhas recentes de um container (sem o horário do Docker); null = não deu para ler. */
export type RecentLogs = (id: string, signal?: AbortSignal) => Promise<string[] | null>;

/** As funções do Docker que a leitura usa (docker-logs.ts; os testes passam dublês). */
export interface LogReaders {
  inspect(id: string, signal?: AbortSignal): Promise<Pick<ContainerRuntime, "tty"> | null>;
  logs(id: string, opts: { tail: number; sinceSeconds: number | null; maxBytes: number; timeoutMs: number; signal?: AbortSignal }): Promise<DockerLogsResult>;
}

/** Monta o leitor de linhas recentes: TTY decide o formato do fluxo; cores e controles saem. */
export function recentLogReader(readers: LogReaders): RecentLogs {
  return async (id, signal) => {
    const rt = await readers.inspect(id, signal);
    if (rt === null) return null;
    const res = await readers.logs(id, { tail: AOF_LOG_TAIL, sinceSeconds: null, maxBytes: AOF_LOG_MAX_BYTES, timeoutMs: AOF_LOG_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    return demuxLogStream(res.body, rt.tty).map((l) => stripLogControl(splitTimestamp(l.text).text));
  };
}

/** O container está em ciclo de reinício agora (a regra do semáforo de projetos)? */
export function inRestartLoop(c: ContainerStatus, nowSec: number): boolean {
  const reasons = problemReasons(c, nowSec);
  return reasons.includes("restarting") || reasons.includes("restart_loop");
}

interface Entry {
  slug: string;
  service: string;
  name: string;
  finding: AofCorruption;
}

export class AofDiagnoser {
  private readonly found = new Map<string, Entry>();

  constructor(private readonly deps: { logs: RecentLogs; log?: (message: string) => void }) {}

  /** Uma volta do coletor. Nunca lança. */
  async observe(tick: TickResult, signal?: AbortSignal): Promise<void> {
    // sem leitura do Docker nesta volta, nada se sabe: mantém o que havia
    if (!tick.dockerOk) return;
    const looping = new Map<string, ContainerStatus>();
    for (const c of tick.containers) {
      if (c.managed && c.slug !== null && inRestartLoop(c, tick.t)) looping.set(c.id, c);
    }
    for (const id of [...this.found.keys()]) if (!looping.has(id)) this.found.delete(id);
    for (const c of [...looping.values()].slice(0, AOF_MAX_PER_TICK)) {
      if (signal?.aborted) return;
      let lines: string[] | null;
      try {
        lines = await this.deps.logs(c.id, signal);
      } catch (err) {
        this.deps.log?.(`aof: log de ${c.name} não lido (${err instanceof Error ? err.message : String(err)})`);
        lines = null;
      }
      if (lines === null) continue; // leitura falhou: fica o que se sabia
      const finding = detectAofCorruption(lines);
      if (finding) this.found.set(c.id, { slug: c.slug!, service: c.service ?? c.name, name: c.name, finding });
      else this.found.delete(c.id);
    }
  }

  /** O AOF corrompido deste container, se ele está em ciclo por isso. */
  forContainer(id: string): AofCorruption | null {
    return this.found.get(id)?.finding ?? null;
  }

  /** Serviços do projeto em ciclo por causa do AOF (ordenados por serviço). */
  forProject(slug: string): ProjectAofFinding[] {
    const out: ProjectAofFinding[] = [];
    for (const e of this.found.values()) {
      if (e.slug !== slug) continue;
      out.push({ service: e.service, container: e.name, engine: e.finding.engine, kind: e.finding.kind, file: e.finding.file, bytes: e.finding.bytes });
    }
    return out.sort((a, b) => a.service.localeCompare(b.service) || a.container.localeCompare(b.container));
  }
}

/** A causa em palavras, para o detalhe do alerta "reinicia sem parar". */
export function aofCauseText(f: AofCorruption): string {
  const name = f.engine === "valkey" ? "valkey" : "redis";
  const size = f.bytes !== null ? ` (${f.bytes} bytes no fim que não puderam ser lidos)` : "";
  return (
    ` Causa: o arquivo de dados do ${name} (${f.file}) ficou com o final corrompido${size}, o que costuma acontecer depois de uma queda brusca da VPS.` +
    ` Na aba Recursos do projeto há o botão para reparar: o painel faz uma cópia da pasta antes e descarta só o final corrompido.`
  );
}
