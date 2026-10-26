/**
 * mail-health-ack-store.ts — marcações "ciente" da saúde do e-mail, guardadas em
 * <dataDir>/mail-health-acks.json.
 *
 * "Ciente" serve para o item que depende do provedor da VPS (o nome reverso do
 * IP, a porta 25): a pessoa leu, decidiu não fazer agora e não quer que ele
 * deixe o resumo em "Atenção". A marcação guarda a impressão do problema do
 * momento (nível, código, esperado, encontrado): se o problema mudar, ela deixa
 * de valer sozinha (ver applyAcknowledgements, em @paas/mailer).
 *
 * Os itens marcáveis são do SERVIDOR (valem para todos os domínios), então a
 * marcação é uma só por item, não por domínio. Só o motivo (texto curto da
 * pessoa) e a data ficam no arquivo: nada secreto.
 */
import path from "node:path";
import { isMailHealthAcknowledgeable, MAIL_HEALTH_ACK_REASON_MAX, MTA_STS_ID_GRACE_MS, type MailHealthCheckId } from "@paas/core";
import type { StoredAcknowledgement } from "@paas/mailer";
import { JsonFile } from "./json-file.js";

export type AckMap = Partial<Record<MailHealthCheckId, StoredAcknowledgement>>;

function validAck(v: unknown): v is StoredAcknowledgement {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.fingerprint === "string" &&
    typeof a.at === "string" &&
    Number.isFinite(Date.parse(a.at)) &&
    (a.reason === null || typeof a.reason === "string") &&
    (a.by === null || typeof a.by === "string")
  );
}

/** Modo (testing/enforce) da última vez que a política MTA-STS de cada domínio abriu: base do aviso "deixou de abrir". */
export class MtaStsModeStore {
  private readonly file: JsonFile<Record<string, string>>;

  constructor(dataDir: string) {
    this.file = new JsonFile<Record<string, string>>(path.join(dataDir, "mail-health-mta-sts-modes.json"), {
      empty: () => ({}),
      parse: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const out: Record<string, string> = {};
        for (const [domain, mode] of Object.entries(raw)) if (mode === "testing" || mode === "enforce") out[domain] = mode;
        return out;
      },
    });
  }

  async get(domain: string): Promise<string | null> {
    return (await this.file.read())[domain] ?? null;
  }

  /** Esquece o modo do domínio (TXT removido ou domínio de e-mail removido). */
  async remove(domain: string): Promise<void> {
    if ((await this.file.read())[domain] === undefined) return;
    await this.file.update((cur) => {
      const { [domain]: _gone, ...rest } = cur;
      return rest;
    });
  }

  /** Grava só quando mudou (a verificação diária não reescreve o arquivo à toa). */
  async set(domain: string, mode: string): Promise<void> {
    if ((await this.file.read())[domain] === mode) return;
    await this.file.update((cur) => ({ ...cur, [domain]: mode }));
  }
}

interface IdEntry {
  /** Último id esperado que o painel viu. */
  id: string;
  /** Ids anteriores ainda aceitos no TXT, até a data. */
  previous: Array<{ id: string; until: number }>;
}

/**
 * Id da política MTA-STS de cada domínio e dos ids anteriores. RFC 8461 §3.1: o `id` do TXT só avisa quem já
 * guardou a política que ela mudou, e quem guardou a anterior a usa até o `max_age` (1 dia). Quando a política
 * muda (por exemplo, o servidor de e-mail), o TXT com o id anterior continua aceito por esse prazo, e a tela só
 * lembra de atualizar; passado o prazo, é "id desatualizado".
 */
export class MtaStsIdStore {
  private readonly file: JsonFile<Record<string, IdEntry>>;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile<Record<string, IdEntry>>(path.join(dataDir, "mail-health-mta-sts-ids.json"), {
      empty: () => ({}),
      parse: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const out: Record<string, IdEntry> = {};
        for (const [domain, entry] of Object.entries(raw)) {
          const e = entry as Partial<IdEntry> | null;
          if (!e || typeof e.id !== "string" || !Array.isArray(e.previous)) continue;
          out[domain] = {
            id: e.id,
            previous: e.previous.filter((p): p is { id: string; until: number } => typeof p?.id === "string" && Number.isFinite(p.until)),
          };
        }
        return out;
      },
    });
  }

  /** Registra o id esperado agora e devolve os ids anteriores que ainda valem. */
  async observe(domain: string, currentId: string): Promise<string[]> {
    const t = this.now();
    const cur = (await this.file.read())[domain];
    const live = (cur?.previous ?? []).filter((p) => p.until > t && p.id !== currentId);
    if (cur && cur.id === currentId && live.length === cur.previous.length) return live.map((p) => p.id);
    const previous = cur && cur.id !== currentId ? [{ id: cur.id, until: t + MTA_STS_ID_GRACE_MS }, ...live] : live;
    await this.file.update((all) => ({ ...all, [domain]: { id: currentId, previous } }));
    return previous.map((p) => p.id);
  }

  async remove(domain: string): Promise<void> {
    if ((await this.file.read())[domain] === undefined) return;
    await this.file.update((cur) => {
      const { [domain]: _gone, ...rest } = cur;
      return rest;
    });
  }
}

/** Aquecimentos de emissão do MTA-STS já feitos (para o teto por hora sobreviver a reinícios em sequência). */
export interface MtaStsWarmLog {
  /** Instantes dos aquecimentos da criação e da rodada periódica. */
  routine: number[];
  /** Instantes dos aquecimentos pedidos pelo botão "Verificar". */
  manual: number[];
  /** Último aquecimento de cada domínio. */
  last: Record<string, number>;
}

/** Guarda em arquivo o registro dos aquecimentos: reiniciar o painel não zera os tetos nem os intervalos. */
export class MtaStsWarmStore {
  private readonly file: JsonFile<MtaStsWarmLog>;

  constructor(dataDir: string) {
    const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : []);
    this.file = new JsonFile<MtaStsWarmLog>(path.join(dataDir, "mail-health-mta-sts-warm.json"), {
      empty: () => ({ routine: [], manual: [], last: {} }),
      parse: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const r = raw as Partial<MtaStsWarmLog>;
        const last: Record<string, number> = {};
        if (r.last && typeof r.last === "object" && !Array.isArray(r.last)) {
          for (const [domain, at] of Object.entries(r.last)) if (typeof at === "number" && Number.isFinite(at)) last[domain] = at;
        }
        return { routine: nums(r.routine), manual: nums(r.manual), last };
      },
    });
  }

  load(): Promise<MtaStsWarmLog> {
    return this.file.read();
  }

  async save(log: MtaStsWarmLog): Promise<void> {
    await this.file.update(() => log);
  }
}

export class MailHealthAckStore {
  private readonly file: JsonFile<AckMap>;

  constructor(dataDir: string) {
    this.file = new JsonFile<AckMap>(path.join(dataDir, "mail-health-acks.json"), {
      empty: () => ({}),
      parse: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const out: AckMap = {};
        for (const [id, ack] of Object.entries(raw)) {
          if (isMailHealthAcknowledgeable(id) && validAck(ack)) {
            out[id] = { fingerprint: ack.fingerprint, at: ack.at, reason: ack.reason, by: ack.by };
          }
        }
        return out;
      },
    });
  }

  async all(): Promise<AckMap> {
    return this.file.read();
  }

  /** Grava (ou troca) a marcação do item. O motivo é aparado e limitado. */
  async set(id: MailHealthCheckId, ack: StoredAcknowledgement): Promise<void> {
    const reason = ack.reason?.trim().slice(0, MAIL_HEALTH_ACK_REASON_MAX) || null;
    await this.file.update((cur) => ({ ...cur, [id]: { ...ack, reason } }));
  }

  /** Desmarca. Devolve se havia marcação. */
  async remove(id: MailHealthCheckId): Promise<boolean> {
    let had = false;
    await this.file.update((cur) => {
      if (!(id in cur)) return cur;
      had = true;
      const { [id]: _gone, ...rest } = cur;
      return rest;
    });
    return had;
  }
}
