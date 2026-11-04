/**
 * health-check.ts — etapa 5/5 do deploy: o site respondeu pelo proxy central?
 *
 * Sai do engine.ts (que depende do Docker e fica fora da cobertura) para que
 * a decisão "o deploy passou?" seja testada sem Docker: as sondas HTTP/HTTPS
 * e o relógio são injetáveis.
 */
import http from "node:http";
import https from "node:https";

export type LogFn = (chunk: string) => void;

/** Resposta de uma sonda: status HTTP (com o Location, se houver) ou erro de conexão/TLS. */
export interface ProbeResult {
  ok: boolean;
  status?: number;
  location?: string;
  error?: string;
}

export type Probe = (host: string, port: number, domain: string) => Promise<ProbeResult>;

export interface HealthCheckOptions {
  host: string;
  httpPort: number;
  httpsPort: number;
  domain: string;
  onLog: LogFn;
  timeoutMs?: number;
  httpsTimeoutMs?: number;
  probeHttp?: Probe;
  probeHttps?: Probe;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isLocal(domain: string): boolean {
  return domain.endsWith(".localhost") || domain === "localhost";
}

/** 4xx: o app respondeu (a raiz pode pedir login, outro método, etc.). */
function isClientError(result: ProbeResult): boolean {
  return !result.ok && result.status !== undefined && result.status >= 400 && result.status < 500;
}

/**
 * Redirecionamento do próprio Caddy da porta 80 para o HTTPS do mesmo host:
 * o backend nem foi consultado, então não prova nada sobre a aplicação.
 */
export function isHttpsRedirect(result: ProbeResult, domain: string): boolean {
  if (!result.status || result.status < 300 || result.status >= 400 || !result.location) return false;
  try {
    const url = new URL(result.location);
    return url.protocol === "https:" && url.hostname.toLowerCase() === domain.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Espera o site responder pelo proxy central. Regras (achado 12 da revisão):
 *  - fase HTTP: 2xx/3xx do app aprova; o 308 do Caddy para o HTTPS do mesmo
 *    host só mostra que o proxy está de pé — o app fica para a fase HTTPS;
 *  - fase HTTPS: 2xx/3xx com certificado válido aprova; erro de TLS é
 *    certificado pendente (aviso, o DNS pode estar propagando); 5xx com
 *    certificado válido até o prazo é o backend fora do ar — o deploy falha;
 *    4xx na raiz é o app respondendo (aviso, sem falhar).
 *  - qualquer 4xx (HTTP ou HTTPS) é o app respondendo: avisa e segue na
 *    primeira resposta, sem reprovar nem esperar o prazo inteiro. Só 5xx e
 *    falta de resposta reprovam.
 */
export async function waitHealthy(opts: HealthCheckOptions): Promise<void> {
  const { host, httpPort, httpsPort, domain, onLog } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const httpsTimeoutMs = opts.httpsTimeoutMs ?? 90_000;
  const probeHttp = opts.probeHttp ?? httpGet;
  const probeHttps = opts.probeHttps ?? httpsGet;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const deadline = now() + timeoutMs;
  let lastError = "";
  let ok = false;
  let appConfirmed = false;
  let warnedClientError = false;
  while (now() < deadline) {
    const result = await probeHttp(host, httpPort, domain);
    if (result.ok) {
      ok = true;
      appConfirmed = !isHttpsRedirect(result, domain);
      break;
    }
    if (isClientError(result)) {
      // 4xx direto: o app respondeu (a raiz pode pedir login etc.) — não reprova.
      ok = true;
      appConfirmed = true;
      warnedClientError = true;
      onLog(`⚠ O app respondeu HTTP ${result.status} na raiz por ${domain}; ele está no ar, confira se é o esperado.\n`);
      break;
    }
    lastError = result.error ?? `HTTP ${result.status}`;
    await sleep(2_000);
  }
  if (!ok) {
    onLog(`Última resposta do health check: ${lastError}\n`);
    throw new Error(`health check falhou após ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
  }
  // 4xx direto: o aviso do app já foi dado no laço acima.
  if (!warnedClientError) {
    if (appConfirmed) onLog(`Health check OK — o proxy responde por ${domain}.\n`);
    else onLog(`O proxy responde por ${domain} e redireciona para o HTTPS — a aplicação é conferida por lá.\n`);
  }
  if (isLocal(domain)) return;

  // HTTPS: o Caddy emite o certificado na primeira visita (Let's Encrypt).
  const httpsDeadline = now() + httpsTimeoutMs;
  let last: ProbeResult = { ok: false, error: "sem resposta" };
  while (now() < httpsDeadline) {
    last = await probeHttps(host, httpsPort, domain);
    if (isClientError(last)) break; // certificado válido e o app respondeu 4xx: não há o que esperar
    if (last.ok) {
      onLog(`HTTPS pronto (certificado válido) — o site está no ar em https://${domain}\n`);
      return;
    }
    await sleep(3_000);
  }
  const seconds = Math.round(httpsTimeoutMs / 1000);
  if (last.status !== undefined && last.status >= 500) {
    onLog(`Última resposta do health check (HTTPS): HTTP ${last.status}\n`);
    throw new Error(
      `health check falhou após ${seconds}s: o certificado está válido, mas a aplicação respondeu HTTP ${last.status} ` +
        `por https://${domain} — ela não está no ar (veja os logs do container).`,
    );
  }
  if (last.status !== undefined) {
    onLog(
      `⚠ HTTPS pronto (certificado válido), mas a raiz do site respondeu HTTP ${last.status}. ` +
        `A aplicação está no ar; confira se esse é o comportamento esperado em https://${domain}/.\n`,
    );
    return;
  }
  const reason = last.error ?? "sem resposta";
  onLog(
    appConfirmed
      ? `⚠ O site responde, mas o certificado HTTPS ainda não ficou pronto (${reason}). ` +
          `Se o domínio acabou de ser apontado, o DNS pode estar propagando: o Caddy tenta de novo sozinho.\n`
      : `⚠ O certificado HTTPS ainda não ficou pronto (${reason}) e, como o HTTP só redireciona para o HTTPS, ` +
          `não deu para confirmar que a aplicação responde. Se o domínio acabou de ser apontado, o DNS pode estar ` +
          `propagando: o Caddy tenta de novo sozinho — confira o site quando o certificado sair.\n`,
  );
}

function probe(client: typeof http | typeof https, options: https.RequestOptions): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = client.request({ path: "/", method: "GET", ...options }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      resolve({ ok: status >= 200 && status < 400, status, ...(location ? { location } : {}) });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

/** GET http://<host>:<port>/ com Host: <domain> (passa pelo Caddy central). */
export function httpGet(host: string, port: number, domain: string, timeoutMs = 5_000): Promise<ProbeResult> {
  return probe(http, { host, port, headers: { Host: domain }, timeout: timeoutMs });
}

/** GET https://<host>:<port>/ com SNI e Host = <domain>: exige o certificado válido do domínio. */
export function httpsGet(
  host: string,
  port: number,
  domain: string,
  timeoutMs = 10_000,
  ca?: string,
): Promise<ProbeResult> {
  return probe(https, {
    host,
    port,
    servername: domain,
    headers: { Host: domain },
    timeout: timeoutMs,
    ...(ca ? { ca } : {}),
  });
}
