/**
 * backup-s3.test.ts — cliente do armazenamento compatível com S3 (Cloudflare
 * R2, Backblaze B2, MinIO…): assinatura AWS SigV4, envio simples e em
 * partes, download, listagem com paginação, remoção e as mensagens de erro.
 *
 * Um servidor HTTP local faz o papel do S3 (confere a assinatura de cada
 * pedido). O teste com o MinIO de verdade está no relatório dos backups.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3Storage, StorageError, encodeKey, signV4 } from "../src/services/backup-s3.js";

describe("assinatura SigV4", () => {
  it("bate com o exemplo da documentação da AWS (GET Object)", () => {
    const auth = signV4({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      query: {},
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("codifica a chave por trecho (espaço vira %20, a barra fica)", () => {
    expect(encodeKey("TWS Panel Backups/loja/2026-10-14_03-00.7z")).toBe("TWS%20Panel%20Backups/loja/2026-10-14_03-00.7z");
    expect(encodeKey("a(b)!*'")).toBe("a%28b%29%21%2A%27");
  });
});

// ---------------------------------------------------------------------------
// S3 de mentira
// ---------------------------------------------------------------------------

const ACCESS = "chave-de-acesso-1234";
const SECRET = "segredo-muito-secreto";

interface FakeS3 {
  server: Server;
  url: string;
  objects: Map<string, Buffer>;
  uploads: Map<string, Map<number, Buffer>>;
  requests: string[];
  failNext: { status: number; code: string } | null;
  pageSize: number;
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function xmlError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`);
}

async function startFake(bucket = "meus-backups"): Promise<FakeS3> {
  const fake: FakeS3 = {
    server: null as unknown as Server,
    url: "",
    objects: new Map(),
    uploads: new Map(),
    requests: [],
    failNext: null,
    pageSize: 1000,
  };
  fake.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, "http://x");
      fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (fake.failNext) {
        const f = fake.failNext;
        fake.failNext = null;
        return xmlError(res, f.status, f.code);
      }
      // confere a assinatura com a mesma conta, do lado do "servidor"
      const headers = req.headers as Record<string, string>;
      const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization ?? "")?.[1]?.split(";") ?? [];
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const expected = signV4({
        method: req.method!,
        host: headers.host!,
        path: url.pathname,
        query,
        headers: Object.fromEntries(signed.filter((h) => h !== "host").map((h) => [h, headers[h]!])),
        payloadHash: headers["x-amz-content-sha256"]!,
        region: "auto",
        accessKeyId: ACCESS,
        secretAccessKey: SECRET,
      });
      if (expected !== headers.authorization) return xmlError(res, 403, "SignatureDoesNotMatch");
      if (headers["x-amz-content-sha256"] !== sha(body)) return xmlError(res, 400, "XAmzContentSHA256Mismatch");
      const [, b, ...rest] = url.pathname.split("/");
      if (b !== bucket) return xmlError(res, 404, "NoSuchBucket");
      const key = decodeURIComponent(rest.join("/"));
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const delimiter = url.searchParams.get("delimiter");
        const start = Number(url.searchParams.get("continuation-token") ?? "0");
        const keys = [...fake.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const folders = new Set<string>();
        const files: string[] = [];
        for (const k of keys) {
          const restKey = k.slice(prefix.length);
          if (delimiter && restKey.includes(delimiter)) folders.add(prefix + restKey.split(delimiter)[0] + delimiter);
          else files.push(k);
        }
        const page = files.slice(start, start + fake.pageSize);
        const truncated = start + fake.pageSize < files.length;
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0"?><ListBucketResult>` +
            page
              .map(
                (k) =>
                  `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>2026-10-14T03:00:00.000Z</LastModified><Size>${fake.objects.get(k)!.length}</Size></Contents>`,
              )
              .join("") +
            [...folders].map((f) => `<CommonPrefixes><Prefix>${f}</Prefix></CommonPrefixes>`).join("") +
            `<IsTruncated>${truncated}</IsTruncated>` +
            (truncated ? `<NextContinuationToken>${start + fake.pageSize}</NextContinuationToken>` : "") +
            `</ListBucketResult>`,
        );
      }
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        const id = `up${fake.uploads.size + 1}`;
        fake.uploads.set(id, new Map());
        res.writeHead(200);
        return res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        const parts = fake.uploads.get(url.searchParams.get("uploadId")!);
        if (!parts) return xmlError(res, 404, "NoSuchUpload");
        const n = Number(url.searchParams.get("partNumber"));
        parts.set(n, body);
        res.writeHead(200, { etag: `"etag-${n}"` });
        return res.end();
      }
      if (req.method === "POST" && url.searchParams.has("uploadId")) {
        const id = url.searchParams.get("uploadId")!;
        const parts = fake.uploads.get(id)!;
        const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"etag-(\d+)"<\/ETag>/g)].map((m) => Number(m[1]));
        fake.objects.set(key, Buffer.concat(order.map((n) => parts.get(n)!)));
        fake.uploads.delete(id);
        res.writeHead(200);
        return res.end("<CompleteMultipartUploadResult/>");
      }
      if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
        fake.uploads.delete(url.searchParams.get("uploadId")!);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "PUT") {
        fake.objects.set(key, body);
        res.writeHead(200, { etag: '"x"' });
        return res.end();
      }
      if (req.method === "GET") {
        const obj = fake.objects.get(key);
        if (!obj) return xmlError(res, 404, "NoSuchKey");
        res.writeHead(200, { "content-length": String(obj.length) });
        return res.end(obj);
      }
      if (req.method === "DELETE") {
        fake.objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      return xmlError(res, 400, "NotImplemented");
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

let fake: FakeS3;
let dir: string;

function storage(overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}): S3Storage {
  return new S3Storage({
    endpoint: fake.url,
    region: "auto",
    bucket: "meus-backups",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    ...overrides,
  });
}

beforeEach(async () => {
  fake = await startFake();
  dir = await mkdtemp(path.join(tmpdir(), "paas-s3-"));
});

afterEach(async () => {
  await new Promise((r) => fake.server.close(r));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("S3Storage", () => {
  it("testar conexão: grava, lê e apaga um arquivo pequeno", async () => {
    await storage().test();
    expect(fake.requests.some((r) => r.startsWith("PUT /meus-backups/TWS%20Panel%20Backups/_verificacao/conexao-"))).toBe(true);
    expect(fake.requests.some((r) => r.startsWith("GET /meus-backups/TWS%20Panel%20Backups/_verificacao/conexao-"))).toBe(true);
    expect(fake.requests.some((r) => r.startsWith("DELETE"))).toBe(true);
    expect(fake.objects.size).toBe(0);
  });

  it("envia, baixa, lista e apaga", async () => {
    const file = path.join(dir, "a.7z");
    await writeFile(file, Buffer.from("conteudo do backup"));
    const s = storage();
    await s.upload("TWS Panel Backups/loja/2026-10-14_03-00.7z", file);
    await s.upload("TWS Panel Backups/loja/2026-10-15_03-00.7z", file);
    await s.upload("TWS Panel Backups/_painel/2026-10-15_03-00.7z", file);
    const out = path.join(dir, "b.7z");
    await s.download("TWS Panel Backups/loja/2026-10-14_03-00.7z", out);
    expect((await readFile(out)).toString()).toBe("conteudo do backup");
    const list = await s.list("TWS Panel Backups/loja/");
    expect(list.map((o) => o.key)).toEqual([
      "TWS Panel Backups/loja/2026-10-14_03-00.7z",
      "TWS Panel Backups/loja/2026-10-15_03-00.7z",
    ]);
    expect(list[0]).toMatchObject({ size: 18, lastModified: "2026-10-14T03:00:00.000Z" });
    expect(await s.listFolders("TWS Panel Backups/")).toEqual(["_painel", "loja"]);
    await s.remove("TWS Panel Backups/loja/2026-10-14_03-00.7z");
    expect((await s.list("TWS Panel Backups/loja/")).length).toBe(1);
  });

  it("arquivo grande vai em partes", async () => {
    const file = path.join(dir, "grande.7z");
    const data = Buffer.alloc(2_500_000, 7);
    data.write("inicio");
    await writeFile(file, data);
    await storage({ partSize: 1_000_000, multipartThreshold: 1_500_000 }).upload("TWS Panel Backups/x/2026-10-14_03-00.7z", file);
    expect(fake.objects.get("TWS Panel Backups/x/2026-10-14_03-00.7z")!.equals(data)).toBe(true);
    expect(fake.requests.filter((r) => r.includes("partNumber")).length).toBe(3);
  });

  it("falha numa parte: cancela o envio em partes", async () => {
    const file = path.join(dir, "grande.7z");
    await writeFile(file, Buffer.alloc(2_500_000, 1));
    const s = storage({ partSize: 1_000_000, multipartThreshold: 1_500_000 });
    const original = fake.server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.includes("partNumber=2")) {
        req.resume();
        req.on("end", () => xmlError(res, 500, "InternalError"));
        return;
      }
      original(req, res);
    });
    await expect(s.upload("TWS Panel Backups/x/2026-10-14_03-00.7z", file)).rejects.toBeInstanceOf(StorageError);
    expect(fake.uploads.size).toBe(0);
  });

  it("lista com várias páginas", async () => {
    fake.pageSize = 2;
    for (let i = 0; i < 5; i++) fake.objects.set(`TWS Panel Backups/p/2026-10-1${i}_03-00.7z`, Buffer.from("x"));
    expect((await storage().list("TWS Panel Backups/p/")).length).toBe(5);
  });

  it("chave errada: diz para conferir as chaves", async () => {
    const err = await storage({ secretAccessKey: "outra" }).test().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).message).toMatch(/chave/i);
    expect((err as StorageError).message).not.toContain("outra");
  });

  it("bucket que não existe", async () => {
    const err = await storage({ bucket: "nao-existe" }).test().catch((e: unknown) => e);
    expect((err as StorageError).message).toMatch(/bucket/i);
    expect((err as StorageError).code).toBe("no_such_bucket");
  });

  it("sem permissão e outros erros do servidor", async () => {
    fake.failNext = { status: 403, code: "AccessDenied" };
    expect(((await storage().test().catch((e: unknown) => e)) as StorageError).code).toBe("access_denied");
    fake.failNext = { status: 503, code: "SlowDown" };
    expect(((await storage().list("x/").catch((e: unknown) => e)) as StorageError).message).toMatch(/503/);
  });

  it("arquivo que não existe no armazenamento", async () => {
    const err = await storage().download("TWS Panel Backups/x/nada.7z", path.join(dir, "n")).catch((e: unknown) => e);
    expect((err as StorageError).code).toBe("not_found");
  });

  it("servidor fora do ar", async () => {
    const err = await storage({ endpoint: "http://127.0.0.1:1" }).test().catch((e: unknown) => e);
    expect((err as StorageError).code).toBe("unreachable");
    expect((err as StorageError).message).toMatch(/Não foi possível falar com 127\.0\.0\.1:1/);
  });

  it("endereço sem esquema ganha https e barra final é ignorada", () => {
    const s = new S3Storage({ endpoint: "abc.r2.cloudflarestorage.com/", region: "auto", bucket: "b", accessKeyId: "a", secretAccessKey: "s" });
    expect(s.describe()).toBe("https://abc.r2.cloudflarestorage.com/b");
  });

  it("nomes com & e envio para servidor fora do ar (tenta 3 vezes)", async () => {
    const file = path.join(dir, "a.7z");
    await writeFile(file, "x");
    await storage().upload("TWS Panel Backups/a&b/2026-10-14_03-00.7z", file);
    expect((await storage().list("TWS Panel Backups/a&b/"))[0]!.key).toBe("TWS Panel Backups/a&b/2026-10-14_03-00.7z");
    const err = await storage({ endpoint: "http://127.0.0.1:1" }).upload("k", file).catch((e: unknown) => e);
    expect((err as StorageError).code).toBe("unreachable");
  });

  it("conexão que cai no meio do download apaga o arquivo pela metade", async () => {
    fake.server.removeAllListeners("request");
    fake.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      res.writeHead(200, { "content-length": "1000" });
      res.write("pouco");
      setTimeout(() => res.destroy(), 20);
    });
    const out = path.join(dir, "metade.7z");
    const err = await storage().download("k", out).catch((e: unknown) => e);
    expect((err as StorageError).code).toBe("unreachable");
    await expect(readFile(out)).rejects.toThrow();
  });

  it("envio em partes sem identificador e chave recusada com 401", async () => {
    fake.server.removeAllListeners("request");
    let calls = 0;
    fake.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        calls++;
        if (calls === 1) {
          res.writeHead(200);
          res.end("<InitiateMultipartUploadResult/>");
        } else {
          res.writeHead(401);
          res.end("");
        }
      });
    });
    const file = path.join(dir, "g.7z");
    await writeFile(file, Buffer.alloc(3000, 1));
    const s = storage({ partSize: 1000, multipartThreshold: 1500 });
    expect(((await s.upload("k", file).catch((e: unknown) => e)) as StorageError).code).toBe("server_error");
    expect(((await s.list("x/").catch((e: unknown) => e)) as StorageError).code).toBe("invalid_credentials");
  });
});
