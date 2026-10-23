/**
 * log-config.ts — o que o log HTTP do painel pode conter (achado M3).
 *
 * O `redact` do pino olha campos do objeto, não o texto da URL: o setup token
 * que o terminal do assistente leva em `?token=` saía em claro em
 * `req.url`. O serializador abaixo troca o valor de `token` (e de qualquer
 * outro parâmetro com cara de segredo) antes de a linha ser escrita.
 */
import { SETUP_TOKEN_QUERY } from "@paas/core";

const SECRET_QUERY_PARAMS = new Set([SETUP_TOKEN_QUERY, "access_token", "api_token", "api-token", "bearer", "authorization", "secret", "password", "code"]);

/** Troca, na query da URL, o valor dos parâmetros secretos por [redacted]. */
export function scrubUrl(rawUrl: string): string {
  // Token de API em qualquer parte do endereço (caminho ou query): nunca no log.
  const url = rawUrl.replace(/tws_pat_[A-Za-z0-9_%-]*/gi, "[redacted]");
  const at = url.indexOf("?");
  if (at === -1) return url;
  const query = url
    .slice(at + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const name = eq === -1 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // nome malformado: compara como veio
      }
      return SECRET_QUERY_PARAMS.has(decoded.toLowerCase()) ? `${name}=[redacted]` : pair;
    })
    .join("&");
  return `${url.slice(0, at)}?${query}`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}

/** Serializador de `req` do pino: o padrão do Fastify, com a URL limpa. */
export function requestSerializer(request: LoggedRequest) {
  return {
    method: request.method,
    url: request.url === undefined ? undefined : scrubUrl(request.url),
    host: request.host ?? request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** Opções de log do Fastify (nível vem do chamador). */
export function loggerOptions(level: string) {
  return {
    level,
    // logs estruturados (pino) — nunca logar tokens
    redact: {
      paths: ["req.headers.authorization", `req.headers["x-setup-token"]`, "req.headers.cookie", "req.query.token"],
      censor: "[redacted]",
    },
    serializers: { req: requestSerializer },
  };
}
