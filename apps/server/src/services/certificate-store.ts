/**
 * certificate-store.ts — certificados MANUAIS (página Certificados).
 *
 * Onde fica: <dataDir>/certificates/ (pasta 0700) com
 *  - <id>.crt e <id>.key (0600): o par enviado pela pessoa;
 *  - manual.json (0600): o índice, SEM a chave (nome, emissor, validade,
 *    nomes cobertos, impressão digital, quando foi instalado).
 *
 * O par vai daqui para dentro do container do Caddy a cada sincronização do
 * proxy (CaddyManager.apply → /etc/caddy/certs) e, para mail.<domínio>, para
 * o Stalwart (MailService.currentCertificates prefere o manual). A chave
 * nunca sai pela API, por log ou pela auditoria.
 */
import { X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { certificateFileId, legacyCertificateFileId } from "@paas/core";
import type { ManualCaddyCertificate } from "@paas/deploy";
import type { InspectedCertificate, MailCertificate } from "@paas/mailer";
import { loadJson, writeFileAtomic } from "./json-file.js";

export interface ManualCertificateMeta {
  host: string;
  issuer: string | null;
  validFrom: string;
  validTo: string;
  names: string[];
  fingerprint: string;
  installedAt: string;
}

interface IndexFile {
  certificates: ManualCertificateMeta[];
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Nome de arquivo do host (mesma regra do Caddy e do Stalwart, sem colisão — achado 7). */
const fileId = certificateFileId;

/** Impressão digital do PEM, ou null se não for um certificado. */
function fingerprintOf(cert: string): string | null {
  try {
    return new X509Certificate(cert).fingerprint256;
  } catch {
    return null;
  }
}

/** O nome `host` é coberto por algum dos nomes do certificado (wildcard de um nível)? */
export function covers(names: string[], host: string): boolean {
  return names.some((n) => {
    if (n === host) return true;
    if (!n.startsWith("*.")) return false;
    const rest = host.slice(host.indexOf(".") + 1);
    return host.includes(".") && rest === n.slice(2);
  });
}

export class ManualCertificateStore {
  private readonly dir: string;
  private readonly indexFile: string;
  /** Escritas em fila: duas instalações seguidas não se atropelam no índice. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "certificates");
    this.indexFile = path.join(this.dir, "manual.json");
  }

  async list(): Promise<ManualCertificateMeta[]> {
    // erro de leitura é lançado: a instalação de outro certificado regravaria o índice sem os que já existem
    const certificates = await loadJson<ManualCertificateMeta[]>(this.indexFile, {
      empty: () => [],
      parse: (raw) => {
        const list = (raw as Partial<IndexFile> | null)?.certificates;
        return Array.isArray(list) ? list : null;
      },
    });
    return certificates.filter((c) => HOST_RE.test(c.host));
  }

  async get(host: string): Promise<ManualCertificateMeta | null> {
    return (await this.list()).find((c) => c.host === host) ?? null;
  }

  /** Pares em vigor, para o proxy. Par com arquivo faltando é ignorado. */
  async pairs(): Promise<ManualCaddyCertificate[]> {
    const out: ManualCaddyCertificate[] = [];
    for (const meta of await this.list()) {
      const pair = await this.readPair(meta);
      if (pair) out.push({ host: meta.host, ...pair });
    }
    return out;
  }

  private async readFiles(id: string): Promise<{ cert: string; key: string } | null> {
    try {
      const [cert, key] = await Promise.all([
        readFile(path.join(this.dir, `${id}.crt`), "utf8"),
        readFile(path.join(this.dir, `${id}.key`), "utf8"),
      ]);
      return { cert, key };
    } catch {
      return null;
    }
  }

  /**
   * Par do host. Sem o arquivo com o nome atual, procura o do nome antigo
   * (regra que colidia) e o migra — mas só se a impressão digital bater com
   * a do índice: na colisão, o arquivo antigo ficou com o certificado do
   * ÚLTIMO domínio instalado, e entregá-lo a outro nome seria servir o
   * certificado errado. Sem par que bata, o host fica sem par (o painel
   * mostra que falta reenviar).
   */
  private async readPair(meta: ManualCertificateMeta): Promise<{ cert: string; key: string } | null> {
    const all = await this.list();
    const current = await this.readFiles(fileId(meta.host));
    if (current && this.isOurs(meta, current.cert, all)) return current;
    const legacyId = legacyCertificateFileId(meta.host);
    if (legacyId === fileId(meta.host)) return null;
    let migrated: { cert: string; key: string } | null = null;
    await this.queue(async () => {
      migrated = await this.migrateLegacy(meta);
    });
    return migrated;
  }

  /**
   * O arquivo com o id ATUAL do host é dele? Sim se a impressão digital bate
   * com a do índice. Se não bate, só vale quando nenhum OUTRO host do índice
   * tem esse id como id antigo: o id novo de um nome sem hífen (a.b.com →
   * a-b-com) é o id antigo de um nome com hífen (a-b.com), e enquanto este
   * não migra o arquivo é dele — o outro não pode servi-lo nem apagá-lo.
   */
  private isOurs(meta: ManualCertificateMeta, cert: string, all: ManualCertificateMeta[]): boolean {
    if (fingerprintOf(cert) === meta.fingerprint) return true;
    const id = fileId(meta.host);
    return !all.some((o) => o.host !== meta.host && legacyCertificateFileId(o.host) === id);
  }

  /** Passa o par do nome antigo para o novo (na fila de escrita). Devolve o par do host, se há. */
  private async migrateLegacy(meta: ManualCertificateMeta): Promise<{ cert: string; key: string } | null> {
    const id = fileId(meta.host);
    const legacyId = legacyCertificateFileId(meta.host);
    const all = await this.list();
    const here = await this.readFiles(id); // outra leitura pode ter migrado antes
    if (here && this.isOurs(meta, here.cert, all)) return here;
    if (legacyId === id) return null;
    const old = await this.readFiles(legacyId);
    if (!old || fingerprintOf(old.cert) !== meta.fingerprint) return null;
    // o id novo pode ser o id antigo de outro host ainda não migrado: ele sai primeiro
    for (const other of all) {
      if (other.host !== meta.host && legacyCertificateFileId(other.host) === id && fileId(other.host) !== id) {
        await this.migrateLegacy(other);
      }
    }
    await writeSecret(path.join(this.dir, `${id}.crt`), old.cert);
    await writeSecret(path.join(this.dir, `${id}.key`), old.key);
    await rm(path.join(this.dir, `${legacyId}.crt`), { force: true });
    await rm(path.join(this.dir, `${legacyId}.key`), { force: true });
    return old;
  }

  /**
   * Certificado manual que vale para `host` (o próprio ou um wildcard de
   * outro nome que o cubra), no formato do servidor de e-mail. null = nenhum.
   */
  async forHost(host: string): Promise<MailCertificate | null> {
    const all = await this.list();
    const meta = all.find((c) => c.host === host) ?? all.find((c) => covers(c.names, host));
    if (!meta) return null;
    const pair = await this.readPair(meta);
    if (!pair) return null;
    const fingerprint = fingerprintOf(pair.cert);
    if (!fingerprint) return null;
    return { host, cert: pair.cert, key: pair.key, fingerprint, issuer: meta.issuer, validTo: meta.validTo };
  }

  /** Grava o par (já conferido) e o índice. */
  async install(host: string, inspected: InspectedCertificate, installedAt: string): Promise<ManualCertificateMeta> {
    if (!HOST_RE.test(host)) throw new Error(`nome inválido: ${JSON.stringify(host)}`);
    const meta: ManualCertificateMeta = {
      host,
      issuer: inspected.issuer,
      validFrom: inspected.validFrom,
      validTo: inspected.validTo,
      names: inspected.names,
      fingerprint: inspected.fingerprint,
      installedAt,
    };
    await this.queue(async () => {
      await this.ensureDir();
      const id = fileId(host);
      // o arquivo deste id pode ser, ainda, o par antigo de outro host: ele migra antes
      for (const other of await this.list()) {
        if (other.host !== host && legacyCertificateFileId(other.host) === id && fileId(other.host) !== id) {
          await this.migrateLegacy(other);
        }
      }
      await writeSecret(path.join(this.dir, `${id}.crt`), inspected.cert);
      await writeSecret(path.join(this.dir, `${id}.key`), inspected.key);
      const others = (await this.list()).filter((c) => c.host !== host);
      await this.writeIndex([...others, meta]);
    });
    return meta;
  }

  /** Apaga o par e tira do índice. false = não havia manual para o nome. */
  async remove(host: string): Promise<boolean> {
    let removed = false;
    await this.queue(async () => {
      const all = await this.list();
      const meta = all.find((c) => c.host === host);
      if (!meta) return;
      removed = true;
      await this.writeIndex(all.filter((c) => c.host !== host));
      const id = fileId(host);
      const here = await this.readFiles(id);
      // arquivo do id novo que é, ainda, o par antigo de outro host: não é deste
      if (!here || this.isOurs(meta, here.cert, all)) {
        await rm(path.join(this.dir, `${id}.crt`), { force: true });
        await rm(path.join(this.dir, `${id}.key`), { force: true });
      }
      // par ainda com o nome antigo (não migrado): sai junto, se for deste host
      const legacyId = legacyCertificateFileId(host);
      const old = legacyId === id ? null : await this.readFiles(legacyId);
      if (old && fingerprintOf(old.cert) === meta.fingerprint) {
        await rm(path.join(this.dir, `${legacyId}.crt`), { force: true });
        await rm(path.join(this.dir, `${legacyId}.key`), { force: true });
      }
    });
    return removed;
  }

  private queue(task: () => Promise<void>): Promise<void> {
    const next = this.writing.then(task, task);
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // mkdir não muda a permissão de uma pasta que já existia
    await chmod(this.dir, 0o700);
  }

  private async writeIndex(certificates: ManualCertificateMeta[]): Promise<void> {
    await this.ensureDir();
    await writeSecret(this.indexFile, JSON.stringify({ certificates }, null, 2) + "\n");
  }
}

/** Grava com 0600 (também quando o arquivo já existia com outra permissão). */
async function writeSecret(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content);
}
