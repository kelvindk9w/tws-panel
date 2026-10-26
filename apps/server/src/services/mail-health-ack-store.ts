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
import { isMailHealthAcknowledgeable, MAIL_HEALTH_ACK_REASON_MAX, type MailHealthCheckId } from "@paas/core";
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

  /** Grava só quando mudou (a verificação diária não reescreve o arquivo à toa). */
  async set(domain: string, mode: string): Promise<void> {
    if ((await this.file.read())[domain] === mode) return;
    await this.file.update((cur) => ({ ...cur, [domain]: mode }));
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
