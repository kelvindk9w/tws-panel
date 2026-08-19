/**
 * domains.ts — verificação de DNS antes de apontar um domínio (plano §5.2).
 * Em dev local, *.localhost resolve automaticamente para loopback.
 */
import dns from "node:dns/promises";
import os from "node:os";
import type { FastifyPluginAsync } from "fastify";
import type { DomainCheckResponse } from "@paas/core";

function machineIps(): string[] {
  const ips = new Set<string>();
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) ips.add(info.address);
    }
  }
  ips.add("127.0.0.1");
  const publicIp = process.env.PAAS_PUBLIC_IP?.trim();
  if (publicIp) ips.add(publicIp);
  return [...ips];
}

const domainsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { domain?: string } }>("/api/domains/check", async (request, reply) => {
    const domain = (request.query.domain ?? "").trim().toLowerCase();
    if (!domain) {
      return reply.code(400).send({ error: "invalid_domain", message: "Informe ?domain=..." });
    }

    const mine = machineIps();

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
          ? "O domínio não resolveu nenhum registro A. Crie um registro A apontando para o IP desta máquina."
          : "O domínio não aponta para esta máquina. Ajuste o registro A no provedor de DNS antes de emitir o certificado.",
    };
    return reply.send(response);
  });
};

export default domainsRoutes;
