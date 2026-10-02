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
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManualCaddyCertificate } from "@paas/deploy";
import type { InspectedCertificate, MailCertificate } from "@paas/mailer";

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

/** Nome de arquivo do host (mesma regra do Caddy e do Stalwart). */
function fileId(host: string): string {
  return host.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
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
    try {
      const raw = JSON.parse(await readFile(this.indexFile, "utf8")) as Partial<IndexFile>;
      return Array.isArray(raw.certificates) ? raw.certificates.filter((c) => HOST_RE.test(c.host)) : [];
    } catch {
      return [];
    }
  }

  async get(host: string): Promise<ManualCertificateMeta | null> {
    return (await this.list()).find((c) => c.host === host) ?? null;
  }

  /** Pares em vigor, para o proxy. Par com arquivo faltando é ignorado. */
  async pairs(): Promise<ManualCaddyCertificate[]> {
    const out: ManualCaddyCertificate[] = [];
    for (const meta of await this.list()) {
      const pair = await this.readPair(meta.host);
      if (pair) out.push({ host: meta.host, ...pair });
    }
    return out;
  }

  private async readPair(host: string): Promise<{ cert: string; key: string } | null> {
    try {
      const id = fileId(host);
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
   * Certificado manual que vale para `host` (o próprio ou um wildcard de
   * outro nome que o cubra), no formato do servidor de e-mail. null = nenhum.
   */
  async forHost(host: string): Promise<MailCertificate | null> {
    const all = await this.list();
    const meta = all.find((c) => c.host === host) ?? all.find((c) => covers(c.names, host));
    if (!meta) return null;
    const pair = await this.readPair(meta.host);
    if (!pair) return null;
    let fingerprint = meta.fingerprint;
    try {
      fingerprint = new X509Certificate(pair.cert).fingerprint256;
    } catch {
      return null;
    }
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
      if (!all.some((c) => c.host === host)) return;
      removed = true;
      await this.writeIndex(all.filter((c) => c.host !== host));
      const id = fileId(host);
      await rm(path.join(this.dir, `${id}.crt`), { force: true });
      await rm(path.join(this.dir, `${id}.key`), { force: true });
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
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}
