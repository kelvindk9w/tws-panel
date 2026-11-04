/**
 * certificate-failure-store.ts — desde quando cada nome AUTOMÁTICO está com a
 * emissão/renovação falhando, guardado em <dataDir>/certificates/failure-since.json.
 *
 * Por que existe: o painel só lê as últimas 24 h do log do Caddy. Medir "há
 * quanto tempo falha" só com o log dá sempre menos de 24 h, e o alerta crítico
 * "sem certificado há mais de 24 horas" nunca dispararia. Aqui fica o PRIMEIRO
 * instante em que a falha foi vista (ou o mais antigo que o log mostrou); a
 * duração passa a ser medida a partir dele. Zera quando há emissão com sucesso.
 *
 * Só nome de domínio e data: nada secreto. Sobrevive ao reinício do painel.
 */
import path from "node:path";
import { JsonFile } from "./json-file.js";

type SinceMap = Record<string, string>;

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

function validTime(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export class CertificateFailureStore {
  private readonly file: JsonFile<SinceMap>;

  constructor(dataDir: string) {
    this.file = new JsonFile<SinceMap>(path.join(dataDir, "certificates", "failure-since.json"), {
      empty: () => ({}),
      parse: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const out: SinceMap = {};
        for (const [host, at] of Object.entries(raw)) if (HOST_RE.test(host) && validTime(at)) out[host] = at;
        return out;
      },
    });
  }

  /**
   * Registra que `host` está falhando e devolve o instante mais antigo conhecido:
   * o guardado ou o que o log mostra (`logFirstAt`); sem nenhum dos dois, `nowIso`.
   */
  async record(host: string, logFirstAt: string | null, nowIso: string): Promise<string> {
    const next = await this.file.update((cur) => {
      const times = [cur[host], logFirstAt].filter(validTime);
      const oldest = times.length > 0 ? times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : nowIso;
      return cur[host] === oldest ? cur : { ...cur, [host]: oldest };
    });
    return next[host]!;
  }

  /** O nome voltou a emitir com sucesso: esquece o início da falha. */
  async clear(host: string): Promise<void> {
    await this.file.update((cur) => {
      if (!(host in cur)) return cur;
      return Object.fromEntries(Object.entries(cur).filter(([h]) => h !== host));
    });
  }

  /** Esquece nomes que o painel não serve mais. */
  async prune(keep: Set<string>): Promise<void> {
    await this.file.update((cur) => {
      const kept = Object.entries(cur).filter(([h]) => keep.has(h));
      return kept.length === Object.keys(cur).length ? cur : Object.fromEntries(kept);
    });
  }
}
