/**
 * metrics-oom-stream.ts — assinatura contínua dos eventos de morte por falta de
 * memória (`oom`) do Docker.
 *
 * Por que uma assinatura e não uma consulta por intervalo: o Docker guarda só os
 * 256 eventos mais recentes, de TODOS os tipos, e cada verificação de saúde gera 3.
 * Com dezenas de containers o buffer cobre cerca de um minuto, e a consulta por
 * intervalo perderia mortes até nas voltas normais. Com o stream aberto (filtrado
 * por type=container e event=oom) cada evento chega na hora.
 *
 * Garantias:
 *  - os eventos ficam numa fila em memória com limite (os mais velhos saem se o
 *    coletor não drenar); o coletor chama `drain()` a cada volta;
 *  - cai? Reconecta com espera crescente (1 s até 60 s), pedindo `since` = último
 *    instante visto + 1 ns, para aproveitar o que ainda estiver no buffer do Docker;
 *  - cada evento é identificado e ordenado pelo instante em NANOSSEGUNDOS: o que já
 *    foi visto (reconexão repete o pedido) é ignorado;
 *  - limite de tamanho de linha e de buffer: linha enorme é descartada inteira;
 *  - `stop()` fecha a conexão e cancela a reconexão (desligamento do painel);
 *  - socket indisponível nunca lança: vai ao log (uma vez por queda) e tenta de novo.
 *
 * Limite real: mortes ocorridas enquanto o painel está parado, ou o stream
 * desconectado por tempo maior que o buffer do Docker guarda, podem se perder.
 */
import http from "node:http";

const ID_RE = /^[0-9a-f]{12,64}$/;
const TIME_NANO_RE = /"timeNano":(\d{1,20})/;

export interface OomEvent {
  id: string;
  /** Instante do evento em nanossegundos desde 1970. */
  timeNano: bigint;
}

export interface OomSource {
  start(): void;
  stop(): void;
  /** Entrega (e esvazia) os eventos recebidos desde a última chamada, em ordem de tempo. */
  drain(): OomEvent[];
}

export interface OomStreamOptions {
  socketPath: string;
  log?: (message: string) => void;
  /** Eventos guardados esperando o coletor. */
  maxQueue?: number;
  /** Tamanho máximo de uma linha do stream. */
  maxLineBytes?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export const OOM_QUEUE_MAX = 1000;
export const OOM_LINE_MAX_BYTES = 64 * 1024;

/** `since` do Docker: segundos.nanossegundos. */
export function sinceParam(nano: bigint): string {
  const sec = nano / 1_000_000_000n;
  const frac = (nano % 1_000_000_000n).toString().padStart(9, "0");
  return `${sec}.${frac}`;
}

/** Uma linha do stream → evento; null se não é uma morte por memória de container com id válido. */
export function parseOomLine(line: string): OomEvent | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (ev === null || typeof ev !== "object" || Array.isArray(ev)) return null;
  const rec = ev as Record<string, unknown>;
  if (rec.Type !== undefined && rec.Type !== "container") return null;
  const action = rec.Action ?? rec.status;
  if (action !== "oom") return null;
  const actor = rec.Actor !== null && typeof rec.Actor === "object" ? (rec.Actor as Record<string, unknown>) : {};
  const id = typeof actor.ID === "string" ? actor.ID : rec.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  // o instante em ns passa de 2^53: lê do texto, não do número já arredondado
  const m = TIME_NANO_RE.exec(line);
  let timeNano: bigint;
  if (m) timeNano = BigInt(m[1]!);
  else if (typeof rec.time === "number" && Number.isFinite(rec.time) && rec.time >= 0) timeNano = BigInt(Math.floor(rec.time)) * 1_000_000_000n;
  else return null;
  return { id, timeNano };
}

export class OomEventStream implements OomSource {
  private readonly log: (m: string) => void;
  private readonly maxQueue: number;
  private readonly maxLine: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private queue: OomEvent[] = [];
  private lastNano: bigint | null = null;
  private req: http.ClientRequest | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private backoff: number;
  private announcedDown = false;

  constructor(private readonly o: OomStreamOptions) {
    this.log = o.log ?? (() => undefined);
    this.maxQueue = o.maxQueue ?? OOM_QUEUE_MAX;
    this.maxLine = o.maxLineBytes ?? OOM_LINE_MAX_BYTES;
    this.minBackoff = o.minBackoffMs ?? 1000;
    this.maxBackoff = o.maxBackoffMs ?? 60_000;
    this.backoff = this.minBackoff;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const req = this.req;
    this.req = null;
    req?.destroy();
  }

  drain(): OomEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  private push(ev: OomEvent): void {
    // já visto (a reconexão repete o pedido) ou fora de ordem: ignorado
    if (this.lastNano !== null && ev.timeNano <= this.lastNano) return;
    this.lastNano = ev.timeNano;
    this.queue.push(ev);
    if (this.queue.length > this.maxQueue) this.queue.shift();
  }

  private connect(): void {
    if (!this.running) return;
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["oom"] }));
    const since = this.lastNano === null ? "" : `&since=${sinceParam(this.lastNano + 1n)}`;
    let pending = "";
    let skipping = false;
    const req = http.request({ socketPath: this.o.socketPath, method: "GET", path: `/events?filters=${filters}${since}` }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        this.dropped(`o Docker respondeu ${res.statusCode ?? 0} aos eventos`);
        return;
      }
      this.backoff = this.minBackoff;
      this.announcedDown = false;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        pending += chunk;
        for (;;) {
          const nl = pending.indexOf("\n");
          if (nl === -1) break;
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (skipping) {
            skipping = false; // o resto da linha enorme acabou aqui
            continue;
          }
          if (line.length > this.maxLine) continue;
          const ev = line.trim() === "" ? null : parseOomLine(line);
          if (ev) this.push(ev);
        }
        // sem quebra de linha e já maior que o teto: descarta até a próxima quebra
        if (pending.length > this.maxLine) {
          pending = "";
          skipping = true;
        }
      });
      res.on("end", () => this.dropped("o Docker fechou o stream de eventos"));
      res.on("error", () => this.dropped("o stream de eventos do Docker falhou"));
    });
    req.on("error", () => this.dropped("o Docker não respondeu aos eventos"));
    req.end();
    this.req = req;
  }

  private dropped(reason: string): void {
    if (this.timer !== null) return; // reconexão já agendada (end, error e close chegam juntos)
    this.req = null;
    if (!this.running) return;
    if (!this.announcedDown) {
      this.announcedDown = true;
      this.log(`métricas: ${reason}; tentando de novo`);
    }
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
    this.timer.unref();
  }
}
