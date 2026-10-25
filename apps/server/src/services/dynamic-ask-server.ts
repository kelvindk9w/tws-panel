/**
 * dynamic-ask-server.ts — o `ask` do Caddy (emissão sob demanda).
 *
 * Antes de pedir um certificado para um nome que ainda não tem, o Caddy chama
 * `GET <ask>?domain=<nome>`: resposta 2xx autoriza, qualquer outra recusa. É um
 * servidor HTTP PRÓPRIO, separado do painel (mesmo desenho do ouvido do aviso
 * de envio, mail-send-hook-server.ts):
 *
 *  - porta só da rede interna do Docker: nunca publicada no host e nunca atrás
 *    do Caddy (o site público do painel não tem esta rota). Quem chega de um
 *    endereço que não é privado/loopback recebe 403 antes de qualquer coisa;
 *  - rápido: a decisão sai da memória (DynamicDomainsService.authorize);
 *  - falha fechada: erro interno ou arquivo ilegível = 503, que o Caddy trata
 *    como "não";
 *  - segredo na URL (`?k=...`, o Caddy preserva a query e acrescenta `domain=`):
 *    comparado em tempo constante; quem alcança a porta por dentro do Docker
 *    (webmail, outros containers de infraestrutura) sem conhecê-lo recebe 403;
 *  - sem log: o nome consultado nunca vai para o log do painel (domínios dos
 *    clientes) e o segredo também não;
 *  - limites: no máximo 1200 consultas por minuto e 100 ao mesmo tempo.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlockList, isIP } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AskDecision } from "./dynamic-domains.js";

export const ASK_PATH = "/caddy/ask";

const SECRET_FILE = "dynamic-ask.secret";
const SECRET_RE = /^[0-9a-f]{48}$/;

/** Segredo do `ask`: nasce na primeira vez, fica em data/ (0600) e não muda mais. */
export async function loadAskSecret(dataDir: string): Promise<string> {
  const file = path.join(dataDir, SECRET_FILE);
  try {
    const text = (await readFile(file, "utf8")).trim();
    if (SECRET_RE.test(text)) return text;
  } catch {
    // não existe ainda: cria abaixo
  }
  const secret = randomBytes(24).toString("hex");
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, secret + "\n", { mode: 0o600 });
  return secret;
}

export interface AskServerDeps {
  authorize(host: string): Promise<AskDecision>;
  /** Segredo esperado na query (`k`). Sem ele, só a origem interna vale (testes). */
  secret?: string;
  now?: () => number;
  /** Consultas por minuto (padrão 1200). */
  maxPerMinute?: number;
  /** Consultas ao mesmo tempo (padrão 100). */
  maxConcurrent?: number;
}

const PRIVATE = new BlockList();
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

/** O endereço é da rede interna (Docker, loopback)? "::ffff:172.18.0.2" conta como 172.18.0.2. */
export function isInternalAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(plain);
  if (family === 0) return false;
  return PRIVATE.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Comparação em tempo constante (os dois lados passam por SHA-256 para ter o mesmo tamanho). */
function sameSecret(given: string | null, expected: string): boolean {
  const a = createHash("sha256").update(given ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given !== null;
}

function reply(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export function buildAskServer(deps: AskServerDeps): Server {
  const now = deps.now ?? Date.now;
  const perMinute = deps.maxPerMinute ?? 1200;
  const concurrent = deps.maxConcurrent ?? 100;
  let stamps: number[] = [];
  let inflight = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isInternalAddress(req.socket.remoteAddress)) return reply(res, 403);
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://ask.internal");
    } catch {
      return reply(res, 400);
    }
    if (req.method !== "GET" || url.pathname !== ASK_PATH) return reply(res, 404);
    if (deps.secret !== undefined && !sameSecret(url.searchParams.get("k"), deps.secret)) return reply(res, 403);
    const domain = url.searchParams.get("domain");
    if (!domain || domain.length > 253) return reply(res, 400);
    const t = now();
    stamps = stamps.filter((s) => s > t - 60_000);
    if (stamps.length >= perMinute) return reply(res, 429);
    if (inflight >= concurrent) return reply(res, 503);
    stamps.push(t);
    inflight += 1;
    try {
      const decision = await deps.authorize(domain);
      reply(res, decision.allow ? 200 : 403, decision.allow ? "ok" : "no");
    } catch {
      reply(res, 503);
    } finally {
      inflight -= 1;
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // cliente lento não segura a conexão: o Caddy espera a resposta por poucos segundos
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
