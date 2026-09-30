/**
 * domains.ts — verificação de DNS antes de apontar um domínio (plano §5.2).
 * Em dev local, *.localhost resolve automaticamente para loopback.
 */
import dns from "node:dns/promises";
import os from "node:os";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { DomainCheckResponse } from "@paas/core";
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

function panelDomainOf(app: FastifyInstance): string | null {
  return app.hasDecorator("config") ? (app.config.panelDomain ?? null) : null;
}

function publicIpOf(app: FastifyInstance): string | null {
  return process.env.PAAS_PUBLIC_IP?.trim() || publicIpFromPanelDomain(panelDomainOf(app));
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

const domainsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  app.get<{ Querystring: { domain?: string } }>(
    "/api/domains/check",
    { schema: checkDomainSchema },
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

      const resolved = await dns.resolve4(domain).catch(() => [] as string[]);
      const ok = resolved.some((ip) => mine.includes(ip));
      const response: DomainCheckResponse = {
        domain,
        devLocal: false,
        ok,
        resolvedIps: resolved,
        machineIps: mine,
        message: ok
          ? "O domínio aponta para esta máquina — pronto para emissão de certificado."
          : resolved.length === 0
            ? `O domínio ainda não aponta para lugar nenhum. No seu provedor de DNS, crie um registro do tipo A ` +
              `com o valor ${publicIp ?? "do IP desta máquina"}. A propagação costuma levar de minutos a algumas horas.`
            : `O domínio aponta para ${resolved.join(", ")}, não para esta VPS. No seu provedor de DNS, troque o ` +
              `registro A para ${publicIp ?? "o IP desta máquina"}.`,
      };
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
      const slug = slugify(request.query.name ?? "projeto");
      const panelDomain = panelDomainOf(app);
      const publicIp = publicIpOf(app);
      const auto = panelDomain && publicIpFromPanelDomain(panelDomain) ? `${slug}.${panelDomain}` : `${slug}.localhost`;
      return reply.send({ auto, publicIp });
    },
  );
};

export default domainsRoutes;
