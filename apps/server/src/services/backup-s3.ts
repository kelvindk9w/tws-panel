/**
 * backup-s3.ts — armazenamento externo compatível com S3 (Cloudflare R2,
 * Backblaze B2, Contabo Object Storage, MinIO, AWS S3).
 *
 * Cliente próprio, sem SDK: assinatura AWS Signature V4 (node:crypto) sobre
 * o `fetch` do Node, endereço no estilo "caminho" (endpoint/bucket/chave),
 * que os quatro provedores aceitam. Arquivos grandes vão em partes
 * (multipart upload), lidos do disco uma parte por vez — nunca o arquivo
 * inteiro na memória.
 *
 * Implementa BackupStorage, a mesma interface que o Google Drive (fase 2)
 * vai implementar: o serviço de backups não sabe qual destino está usando.
 *
 * Segredo: a chave secreta só entra no cálculo da assinatura. Mensagens de
 * erro nunca repetem chave, cabeçalho de autorização nem URL assinada.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BACKUP_ROOT_FOLDER } from "@paas/core";

/** Um arquivo no destino. */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: string | null;
}

/**
 * Destino externo dos backups. S3 hoje; Google Drive (login por código de
 * dispositivo, escopo drive.file) entra depois implementando esta mesma
 * interface — chaves são caminhos "TWS Panel Backups/<pasta>/<arquivo>".
 */
export interface BackupStorage {
  /** Grava, lê e apaga um arquivo pequeno: confirma endereço, chaves e permissão. */
  test(): Promise<void>;
  upload(key: string, filePath: string): Promise<void>;
  download(key: string, filePath: string): Promise<void>;
  /** Arquivos com o prefixo (sem as "subpastas"). */
  list(prefix: string): Promise<StoredObject[]>;
  /** Nomes das "pastas" logo abaixo do prefixo. */
  listFolders(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  /** Onde fica, para a tela (sem segredo). */
  describe(): string;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: "unreachable" | "invalid_credentials" | "access_denied" | "no_such_bucket" | "not_found" | "server_error",
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// ---------------------------------------------------------------------------
// Assinatura AWS SigV4
// ---------------------------------------------------------------------------

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Codificação RFC 3986 (a do S3): tudo exceto letras, números e -_.~ */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Chave → caminho na URL: cada trecho codificado, as barras mantidas. */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

export interface SignInput {
  method: string;
  host: string;
  /** Caminho já codificado. */
  path: string;
  query: Record<string, string>;
  /** Cabeçalhos assinados além do host (nomes em minúsculas), com x-amz-date. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Valor do cabeçalho Authorization (AWS4-HMAC-SHA256). */
export function signV4(input: SignInput): string {
  const amzDate = input.headers["x-amz-date"]!;
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = { host: input.host };
  for (const [k, v] of Object.entries(input.headers)) all[k.toLowerCase()] = v;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(input.query[k]!)}`)
    .join("&");
  const canonicalRequest = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Tamanho de cada parte no envio em partes (padrão 32 MB; o S3 exige ≥ 5 MB). */
  partSize?: number;
  /** A partir de quanto o envio vai em partes (padrão 64 MB). */
  multipartThreshold?: number;
  /** Prazo de cada pedido (padrão 30 min — uma parte grande numa conexão lenta). */
  timeoutMs?: number;
  now?: () => Date;
}

function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) out.push(decodeXml(m[1]!));
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface RequestInput {
  method: "GET" | "PUT" | "POST" | "DELETE";
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
  /** Devolve a resposta crua (download em fluxo). */
  raw?: boolean;
}

export class S3Storage implements BackupStorage {
  private readonly base: URL;
  private readonly opts: Required<Omit<S3StorageOptions, "now">> & { now: () => Date };

  constructor(opts: S3StorageOptions) {
    const endpoint = /^https?:\/\//i.test(opts.endpoint) ? opts.endpoint : `https://${opts.endpoint}`;
    this.base = new URL(endpoint.replace(/\/+$/, ""));
    this.opts = {
      partSize: 32 * 1024 * 1024,
      multipartThreshold: 64 * 1024 * 1024,
      timeoutMs: 30 * 60_000,
      now: () => new Date(),
      ...opts,
    };
  }

  describe(): string {
    return `${this.base.origin}/${this.opts.bucket}`;
  }

  private async request(input: RequestInput): Promise<Response> {
    const path = `${this.base.pathname.replace(/\/+$/, "")}/${encodeRfc3986(this.opts.bucket)}${input.key !== undefined ? `/${encodeKey(input.key)}` : ""}`;
    const query = input.query ?? {};
    const qs = Object.keys(query)
      .map((k) => (query[k] === "" && (k === "uploads" || k === "delete") ? k : `${encodeRfc3986(k)}=${encodeRfc3986(query[k]!)}`))
      .join("&");
    const amzDate = this.opts.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payloadHash = input.body ? sha256Hex(input.body) : EMPTY_SHA256;
    const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const authorization = signV4({
      method: input.method,
      host: this.base.host,
      path,
      query,
      headers,
      payloadHash,
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
    });
    let res: Response;
    try {
      res = await fetch(`${this.base.origin}${path}${qs ? `?${qs}` : ""}`, {
        method: input.method,
        headers: { ...headers, authorization, ...(input.body ? { "content-length": String(input.body.length) } : {}) },
        ...(input.body ? { body: input.body } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      throw new StorageError(
        `Não foi possível falar com ${this.base.host}. Confira o endereço (endpoint) e a internet da VPS.`,
        "unreachable",
      );
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const code = xmlValues(text, "Code")[0] ?? "";
    throw this.errorFor(res.status, code);
  }

  private errorFor(status: number, code: string): StorageError {
    if (code === "NoSuchBucket") {
      return new StorageError(`O bucket "${this.opts.bucket}" não existe nesse endereço. Confira o nome do bucket.`, "no_such_bucket");
    }
    if (code === "NoSuchKey" || (status === 404 && code !== "NoSuchUpload")) {
      return new StorageError("Arquivo não encontrado no armazenamento.", "not_found");
    }
    if (["SignatureDoesNotMatch", "InvalidAccessKeyId", "InvalidToken", "AuthorizationHeaderMalformed"].includes(code) || status === 401) {
      return new StorageError(
        "O armazenamento recusou as chaves. Confira a chave de acesso (Access Key ID), a chave secreta e a região.",
        "invalid_credentials",
      );
    }
    if (status === 403) {
      return new StorageError(
        "As chaves não têm permissão neste bucket. Crie o token com permissão de leitura e escrita de objetos nesse bucket.",
        "access_denied",
      );
    }
    return new StorageError(`O armazenamento respondeu com erro ${status}${code ? ` (${code})` : ""}. Tente de novo em instantes.`, "server_error");
  }

  /** Repete o envio em erro do servidor ou de rede (até 3 tentativas). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        const retriable = err instanceof StorageError && (err.code === "server_error" || err.code === "unreachable");
        if (!retriable) throw err;
      }
    }
    throw last;
  }

  async test(): Promise<void> {
    const key = `${BACKUP_ROOT_FOLDER}/_verificacao/conexao-${randomBytes(4).toString("hex")}.txt`;
    const body = Buffer.from("Teste de conexão do TWS Panel. Pode apagar.\n");
    await this.request({ method: "PUT", key, body });
    const back = await this.request({ method: "GET", key });
    await back.arrayBuffer();
    await this.request({ method: "DELETE", key });
  }

  async upload(key: string, filePath: string): Promise<void> {
    const { size } = await stat(filePath);
    const handle = await open(filePath, "r");
    try {
      if (size <= this.opts.multipartThreshold) {
        const body = Buffer.alloc(size);
        await handle.read(body, 0, size, 0);
        await this.withRetry(() => this.request({ method: "PUT", key, body }));
        return;
      }
      const init = await this.request({ method: "POST", key, query: { uploads: "" } });
      const uploadId = xmlValues(await init.text(), "UploadId")[0];
      if (!uploadId) throw new StorageError("O armazenamento não abriu o envio em partes.", "server_error");
      const etags: string[] = [];
      try {
        for (let offset = 0, n = 1; offset < size; offset += this.opts.partSize, n++) {
          const length = Math.min(this.opts.partSize, size - offset);
          const body = Buffer.alloc(length);
          await handle.read(body, 0, length, offset);
          const res = await this.withRetry(() =>
            this.request({ method: "PUT", key, query: { partNumber: String(n), uploadId }, body }),
          );
          etags.push(res.headers.get("etag") ?? "");
        }
        const xml =
          "<CompleteMultipartUpload>" +
          etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
          "</CompleteMultipartUpload>";
        await this.request({ method: "POST", key, query: { uploadId }, body: Buffer.from(xml) });
      } catch (err) {
        await this.request({ method: "DELETE", key, query: { uploadId } }).catch(() => undefined);
        throw err;
      }
    } finally {
      await handle.close();
    }
  }

  async download(key: string, filePath: string): Promise<void> {
    const res = await this.request({ method: "GET", key, raw: true });
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(filePath, { mode: 0o600 }));
    } catch {
      await rm(filePath, { force: true });
      throw new StorageError("A conexão caiu no meio do download. Tente de novo.", "unreachable");
    }
  }

  private async listRaw(prefix: string, delimiter: boolean): Promise<{ objects: StoredObject[]; folders: string[] }> {
    const objects: StoredObject[] = [];
    const folders: string[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (delimiter) query.delimiter = "/";
      if (token) query["continuation-token"] = token;
      const xml = await (await this.request({ method: "GET", query })).text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        objects.push({
          key: xmlValues(block, "Key")[0]!,
          size: Number(xmlValues(block, "Size")[0] ?? 0),
          lastModified: xmlValues(block, "LastModified")[0] ?? null,
        });
      }
      for (const block of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) ?? []) {
        folders.push(xmlValues(block, "Prefix")[0]!);
      }
      token = xmlValues(xml, "IsTruncated")[0] === "true" ? (xmlValues(xml, "NextContinuationToken")[0] ?? null) : null;
    } while (token);
    return { objects, folders };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const { objects } = await this.listRaw(prefix, true);
    return objects.sort((a, b) => a.key.localeCompare(b.key));
  }

  async listFolders(prefix: string): Promise<string[]> {
    const { folders } = await this.listRaw(prefix, true);
    return folders.map((f) => f.slice(prefix.length).replace(/\/$/, "")).filter(Boolean).sort();
  }

  async remove(key: string): Promise<void> {
    await this.request({ method: "DELETE", key });
  }
}
