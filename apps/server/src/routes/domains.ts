/**
 * domains.ts — verificação de DNS antes de apontar um domínio (plano §5.2).
 * Em dev local, *.localhost resolve automaticamente para loopback.
 */
import dns from "node:dns/promises";
import os from "node:os";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  cleanHost,
  pairOf,
  type AutoDomainSuggestion,
  type DomainCheckResponse,
  type DomainDnsState,
  type DomainPairCheck,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { slugify } from "../services/deploy-service.js";

// Hostname RFC 1123 estrito: rótulos de 1–63 caracteres alfanuméricos/hífen
// (sem hífen nas pontas), separados por ponto. Sem isso o valor bruto do
// cliente iria direto para uma consulta DNS real (dns.resolve4).
const HOSTNAME_PATTERN =
  "^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$";

const checkDomainSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      domain: { type: "string", maxLength: 253, pattern: HOSTNAME_PATTERN },
      // projeto que está conectando o domínio: o par já conectado a ele não conta como "ocupado por outro"
      project: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

/**
 * IP público da VPS a partir do endereço sslip.io do painel (1-2-3-4.sslip.io
 * → 1.2.3.4). De dentro do container, as interfaces só mostram o IP da rede do
 * Docker (172.x): sem isto o "Verificar DNS" nunca reconhecia a própria VPS.
 */
export function publicIpFromPanelDomain(panelDomain: string | null | undefined): string | null {
  const m = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/.exec(panelDomain ?? "");
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n <= 255) ? parts.join(".") : null;
}

/** Faixas IPv4 da Cloudflare (fonte: https://www.cloudflare.com/ips-v4, 30/09/2026). */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

/** O IP é do proxy da Cloudflare (registro com a nuvem laranja)? */
export function isCloudflareIp(ip: string): boolean {
  const n = ipToInt(ip);
  return CLOUDFLARE_V4.some((cidr) => {
    const [base, bits] = cidr.split("/") as [string, string];
    const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n & mask) === (ipToInt(base) & mask);
  });
}

function panelDomainOf(app: FastifyInstance): string | null {
  return app.hasDecorator("config") ? (app.config.panelDomain ?? null) : null;
}

function publicIpOf(app: FastifyInstance): string | null {
  return publicIpFromConfig(panelDomainOf(app));
}

/** O painel tem IP público ou um domínio que não é da própria máquina? */
function panelIsPublic(app: FastifyInstance): boolean {
  const panel = (panelDomainOf(app) ?? "").toLowerCase();
  const local = panel === "" || panel === "localhost" || panel.endsWith(".localhost") || panel.startsWith("127.") || panel === "::1";
  return publicIpOf(app) !== null || !local;
}

function machineIps(publicIp: string | null): string[] {
  const ips = new Set<string>();
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) ips.add(info.address);
    }
  }
  ips.add("127.0.0.1");
  if (publicIp) ips.add(publicIp);
  return [...ips];
}

const SILENT_DNS_ERRORS = new Set(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED", "EAI_AGAIN", "ECANCELLED"]);

/**
 * DNS (registro A) de UM nome contra os IPs desta máquina. "Não existe" e
 * qualquer outro erro viram "sem registro", menos o resolvedor mudo
 * (tempo esgotado, SERVFAIL…): ali nada se conclui, e quem decide não pode
 * tratar como "não aponta".
 */
export async function probeHostDns(host: string, mine: string[]): Promise<{ state: DomainDnsState; resolved: string[] }> {
  let resolved: string[];
  try {
    resolved = await dns.resolve4(host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && SILENT_DNS_ERRORS.has(code)) return { state: "unavailable", resolved: [] };
    resolved = [];
  }
  if (resolved.some((ip) => mine.includes(ip))) return { state: "pointed", resolved };
  if (resolved.length === 0) return { state: "missing", resolved };
  return { state: resolved.every(isCloudflareIp) ? "cloudflare" : "elsewhere", resolved };
}

/** Consulta de DNS de um nome para o proxy (par com/sem www): sem resposta em 6 s = "não respondeu". */
export function makeHostState(publicIp: () => string | null): (host: string) => Promise<DomainDnsState> {
  return async (host) => {
    const timeout = new Promise<{ state: DomainDnsState }>((resolve) => {
      setTimeout(() => resolve({ state: "unavailable" }), 6_000).unref();
    });
    return (await Promise.race([probeHostDns(host, machineIps(publicIp())), timeout])).state;
  };
}

/** IP público da VPS para o painel (PAAS_PUBLIC_IP ou o do endereço sslip.io do painel). */
export function publicIpFromConfig(panelDomain: string | null | undefined): string | null {
  return process.env.PAAS_PUBLIC_IP?.trim() || publicIpFromPanelDomain(panelDomain);
}

function dnsMessage(state: DomainDnsState, resolved: string[], publicIp: string | null): string {
  const ip = publicIp ?? "o IP desta máquina";
  switch (state) {
    case "pointed":
      return "O domínio aponta para esta máquina — pronto para emissão de certificado.";
    case "unavailable":
      return "O DNS não respondeu agora. Nada foi alterado; tente verificar de novo em instantes.";
    case "missing":
      return (
        `O domínio ainda não aponta para lugar nenhum. No seu provedor de DNS, crie um registro do tipo A ` +
        `com o valor ${ip}. A propagação costuma levar de minutos a algumas horas.`
      );
    case "cloudflare":
      return (
        `O domínio está com o proxy da Cloudflare ligado (nuvem laranja): ele responde com os IPs da ` +
        `Cloudflare, não com o da VPS, e o painel não consegue emitir o certificado sozinho. Na Cloudflare, ` +
        `abra o registro e mude para a nuvem cinza ("Somente DNS"), com o valor ${ip}.`
      );
    case "elsewhere":
      return `O domínio aponta para ${resolved.join(", ")}, não para esta VPS. No seu provedor de DNS, troque o registro A para ${ip}.`;
  }
}

const domainsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  app.get<{ Querystring: { domain?: string; project?: string } }>(
    "/api/domains/check",
    {
      schema: checkDomainSchema,
      // Nome em Unicode (exämple.com, 公司.cn): vira punycode ANTES da validação do padrão ASCII.
      // Texto inválido segue como veio e a validação responde 400.
      preValidation: async (request) => {
        const query = request.query as { domain?: unknown };
        if (typeof query.domain === "string" && /[^\x00-\x7f]/.test(query.domain)) {
          query.domain = cleanHost(query.domain) || query.domain;
        }
      },
    },
    async (request, reply) => {
      const domain = (request.query.domain ?? "").trim().toLowerCase();
      if (!domain) {
        return reply.code(400).send({ error: "invalid_domain", message: "Informe ?domain=..." });
      }

      const publicIp = publicIpOf(app);
      const mine = machineIps(publicIp);

      // Modo dev local: *.localhost é automático (resolve para 127.0.0.1/::1).
      if (domain === "localhost" || domain.endsWith(".localhost")) {
        const response: DomainCheckResponse = {
          domain,
          devLocal: true,
          ok: true,
          resolvedIps: ["127.0.0.1", "::1"],
          machineIps: mine,
          message:
            "Domínio .localhost: resolve automaticamente para esta máquina. O Caddy serve em HTTP puro (sem certificado) neste modo de desenvolvimento.",
        };
        return reply.send(response);
      }

      const main = await probeHostDns(domain, mine);
      const response: DomainCheckResponse = {
        domain,
        devLocal: false,
        ok: main.state === "pointed",
        state: main.state,
        resolvedIps: main.resolved,
        machineIps: mine,
        message: dnsMessage(main.state, main.resolved, publicIp),
      };
      // O par (com/sem www) é conferido à parte e NUNCA muda o resultado do nome digitado:
      // par que falha é aviso, não erro.
      const pair = pairOf(domain);
      if (pair) {
        const occupant = app.hasDecorator("deployService")
          ? await app.deployService.occupantOf(pair.pair, request.query.project ?? null)
          : null;
        const other = await probeHostDns(pair.pair, mine);
        const check: DomainPairCheck = {
          domain: pair.pair,
          role: pair.role,
          ok: other.state === "pointed",
          state: other.state,
          resolvedIps: other.resolved,
          ...(occupant ? { occupiedBy: occupant } : {}),
          message: dnsMessage(other.state, other.resolved, publicIp),
        };
        response.pair = check;
      }
      return reply.send(response);
    },
  );

  /**
   * Endereço automático do projeto: <projeto>.<ip-com-hífens>.sslip.io — o
   * sslip.io resolve qualquer prefixo para o IP, então funciona na hora, com
   * HTTPS, sem configurar DNS. Sem endereço público (dev local): .localhost.
   */
  app.get<{ Querystring: { name?: string } }>(
    "/api/domains/suggest",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
        },
      },
    },
    async (request, reply) => {
      const name = request.query.name ?? "projeto";
      const slug = slugify(name);
      const panelDomain = panelDomainOf(app);
      const publicIp = publicIpOf(app);
      const sslip = panelDomain && publicIpFromPanelDomain(panelDomain) ? `${slug}.${panelDomain}` : null;
      // Domínio de aplicações verificado: o endereço automático é <projeto>-<sufixo>.<base>
      // (sem o IP da VPS) e o sslip.io fica como alternativa "para testar".
      // Sem ele, a resposta é a de sempre (só auto e publicIp).
      const apps = app.hasDecorator("appsDomainService") ? await app.appsDomainService.suggest(name) : null;
      if (apps) {
        const { base } = await app.appsDomainService.status();
        const response: AutoDomainSuggestion = { auto: apps, publicIp, panelPublic: panelIsPublic(app), kind: "apps", appsBase: base, testAddress: sslip,
          provisional: await app.appsDomainService.suggestProvisional(name),
        };
        return reply.send(response);
      }
      return reply.send({ auto: sslip ?? `${slug}.localhost`, publicIp, panelPublic: panelIsPublic(app) });
    },
  );
};

export default domainsRoutes;
