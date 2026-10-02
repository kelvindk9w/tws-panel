/**
 * caddy-log.ts — o que o Caddy central disse sobre a emissão de cada
 * certificado, lido do `docker logs paas-caddy` (uma linha JSON por evento).
 *
 * Mensagens usadas (certmagic, o motor de certificados do Caddy):
 *  - "obtaining certificate" / "renewing certificate" (identifier);
 *  - "certificate obtained successfully" / "certificate renewed successfully" (identifier, issuer);
 *  - "could not get certificate from issuer" (identifier, issuer, error);
 *  - "will retry" / "final attempt; giving up" (error começando por "[nome]",
 *    attempt, retrying_in em segundos);
 *  - do cliente ACME: "trying to solve challenge" e "challenge failed"
 *    (identifier, challenge_type, problem{type,detail}).
 *
 * Log é dado NÃO confiável (o texto do erro inclui respostas de terceiros):
 * daqui só saem campos conhecidos, o nome tem de ter formato de domínio e o
 * texto mostrado é limitado e sem caracteres de controle. Nada é executado
 * a partir dele.
 */
import type { CertificateErrorCause, CertificateIssueError } from "@paas/core";

export type CaddyCertEventKind = "obtained" | "trying" | "error";

export interface CaddyCertEvent {
  host: string;
  kind: CaddyCertEventKind;
  /** Hora do evento (ISO), quando o log informa. */
  at: string | null;
  /** Texto do erro (limitado, sem controle). */
  detail: string | null;
  /** "will retry": em quantos segundos o Caddy tenta de novo. */
  retryingInSeconds: number | null;
}

/** Linhas maiores que isto são descartadas sem parse. */
const MAX_LINE = 64 * 1024;
/** Tamanho máximo do texto de erro guardado/mostrado. */
export const MAX_DETAIL = 300;

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const OBTAINED = new Set(["certificate obtained successfully", "certificate renewed successfully"]);
const TRYING = new Set([
  "obtaining certificate",
  "renewing certificate",
  "trying to solve challenge",
  "acquiring lock",
  "lock acquired",
]);
const ERRORS = new Set([
  "could not get certificate from issuer",
  "challenge failed",
  "will retry",
  "final attempt; giving up",
  "job failed",
  "validating authorization",
]);

/** Remove caracteres de controle, junta espaços e limita o tamanho. */
export function sanitizeLogText(text: string, max = MAX_DETAIL): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeHost(v: unknown): string | null {
  const s = str(v)?.trim().toLowerCase();
  return s && s.length <= 253 && HOST_RE.test(s) ? s : null;
}

function timeOf(ts: unknown): string | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(Math.round(ts * 1000)).toISOString();
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Nomes citados pela linha: identifier, identifiers[], server_name ou "[nome]" no começo do erro. */
function hostsOf(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const h = normalizeHost(v);
    if (h && !out.includes(h)) out.push(h);
  };
  push(entry.identifier);
  if (Array.isArray(entry.identifiers)) entry.identifiers.slice(0, 20).forEach(push);
  push(entry.server_name);
  if (out.length === 0) {
    const m = /^\[([^\]\s]{1,253})\]/.exec(str(entry.error) ?? "");
    if (m) push(m[1]);
  }
  return out;
}

function detailOf(entry: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const problem = entry.problem;
  if (problem && typeof problem === "object" && !Array.isArray(problem)) {
    const p = problem as Record<string, unknown>;
    if (str(p.type)) parts.push(str(p.type)!);
    if (str(p.detail)) parts.push(str(p.detail)!);
  }
  if (str(entry.error)) parts.push(str(entry.error)!);
  return parts.length ? sanitizeLogText(parts.join(" - ")) : null;
}

/**
 * Último evento de emissão de cada nome no texto do log. Linhas fora do
 * formato são ignoradas.
 */
export function parseCaddyCertificateLog(text: string): Map<string, CaddyCertEvent> {
  const events = new Map<string, CaddyCertEvent>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{") || line.length > MAX_LINE) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const msg = str(e.msg) ?? "";
    const kind: CaddyCertEventKind | null = OBTAINED.has(msg)
      ? "obtained"
      : TRYING.has(msg)
        ? "trying"
        : ERRORS.has(msg)
          ? "error"
          : null;
    if (!kind) continue;
    const at = timeOf(e.ts);
    const detail = kind === "error" ? detailOf(e) : null;
    const retrying = typeof e.retrying_in === "number" && Number.isFinite(e.retrying_in) ? e.retrying_in : null;
    for (const host of hostsOf(e)) {
      // Depois de uma falha, "lock acquired" etc. da tentativa seguinte não apagam o erro
      // até haver resultado: o erro só sai com sucesso ou com nova falha.
      const prev = events.get(host);
      if (kind === "trying" && prev?.kind === "error") continue;
      events.set(host, { host, kind, at, detail, retryingInSeconds: kind === "error" ? retrying : null });
    }
  }
  return events;
}

function formatDateBr(d: Date): string {
  return d.toLocaleString("pt-BR", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + " (UTC)";
}

/**
 * Causa provável de uma falha de emissão, para leigo. O texto vem do
 * Let's Encrypt/ZeroSSL via Caddy; a classificação olha só os tipos de erro
 * ACME e expressões conhecidas.
 */
export function explainIssueError(detailRaw: string, now: Date = new Date()): Omit<CertificateIssueError, "at"> {
  const detail = sanitizeLogText(detailRaw);
  const t = detail.toLowerCase();
  const result = (cause: CertificateErrorCause, message: string, retryAfter: string | null = null) => ({
    cause,
    message,
    detail: detail || null,
    retryAfter,
  });

  if (t.includes("ratelimited") || t.includes("rate limit") || t.includes("too many")) {
    const m = /retry after (\d{4}-\d{2}-\d{2})[ t](\d{2}:\d{2}:\d{2})/i.exec(detail);
    const when = m ? new Date(`${m[1]}T${m[2]}Z`) : null;
    if (when && !Number.isNaN(when.getTime())) {
      const future = when.getTime() > now.getTime();
      return result(
        "rate_limit",
        `O Let's Encrypt limitou as emissões para este nome (muitos pedidos seguidos). ` +
          (future
            ? `Dá para tentar de novo a partir de ${formatDateBr(when)}. Até lá, o painel continua tentando sozinho e não adianta clicar.`
            : "O prazo do limite já passou: pode tentar de novo."),
        when.toISOString(),
      );
    }
    return result(
      "rate_limit",
      "O Let's Encrypt limitou as emissões para este nome (muitas tentativas seguidas). Espere cerca de 1 hora antes de tentar de novo; o painel continua tentando sozinho.",
    );
  }
  if (t.includes(":caa") || t.includes("caa record")) {
    return result(
      "caa",
      "Um registro CAA no DNS do domínio não autoriza o Let's Encrypt a emitir. Remova o CAA ou inclua \"letsencrypt.org\" nele.",
    );
  }
  if (
    t.includes("cloudflare") ||
    t.includes("acme-tls/1") ||
    /: 52[0-6]\b/.test(t) ||
    /2606:4700|2803:f800|2405:b500|2405:8100|2a06:98c0|2c0f:f248/.test(t)
  ) {
    return result(
      "cloudflare",
      "A Cloudflare está na frente deste nome (nuvem laranja) e atende no lugar da VPS. No painel da Cloudflare, deixe a nuvem CINZA (\"Somente DNS\") neste registro e tente de novo.",
    );
  }
  if (
    t.includes(":connection") ||
    t.includes("timeout") ||
    t.includes("connection refused") ||
    t.includes("firewall") ||
    t.includes("connection reset")
  ) {
    return result(
      "firewall",
      "O Let's Encrypt não conseguiu falar com a VPS. Confira se as portas 80 e 443 estão abertas no firewall da VPS e no painel do provedor, e se o DNS aponta para o IP certo.",
    );
  }
  if (
    t.includes(":dns") ||
    t.includes("nxdomain") ||
    t.includes("no valid a records") ||
    t.includes("dns problem") ||
    t.includes(":unauthorized") ||
    t.includes("invalid response")
  ) {
    return result(
      "dns",
      "O DNS deste nome não aponta para esta VPS (o registro A não existe ou leva a outro servidor). Crie ou corrija o registro A com o IP da VPS e tente de novo depois que propagar.",
    );
  }
  return result(
    "unknown",
    "A emissão falhou por um motivo que o painel não reconheceu. O Caddy continua tentando sozinho; veja o detalhe abaixo.",
  );
}
