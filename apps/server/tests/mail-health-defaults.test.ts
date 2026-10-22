/**
 * MailHealthService com os padrões de produção (resolvedores públicos e busca
 * da política MTA-STS), com o módulo de DNS do Node trocado por um falso: nada
 * sai para a rede. A busca da política recusa o nome que resolve para rede
 * privada (a proteção contra SSRF).
 */
import { describe, expect, it, vi } from "vitest";

const servers: string[][] = [];

vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers(s: string[]) {
      servers.push(s);
    }
    private fail() {
      return Promise.reject(Object.assign(new Error("nf"), { code: "ENOTFOUND" }));
    }
    resolve4() {
      return this.fail();
    }
    resolve6() {
      return this.fail();
    }
    resolveMx() {
      return this.fail();
    }
    reverse() {
      return this.fail();
    }
    resolveTxt(name: string) {
      return name.startsWith("_mta-sts.") ? Promise.resolve([["v=STSv1; id=1"]]) : this.fail();
    }
  }
  const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
  return { default: { Resolver, lookup }, Resolver, lookup };
});

const { MailHealthService } = await import("../src/services/mail-health-service.js");

describe("MailHealthService com resolvedores e busca de política padrão", () => {
  it("consulta 3 resolvedores públicos e não conecta em política que resolve para rede privada", async () => {
    const service = new MailHealthService({
      planInput: async () => ({
        domain: "envio.exemplo.com.br",
        mailHostname: "mail.envio.exemplo.com.br",
        serverHostname: "mail.envio.exemplo.com.br",
        serverIp: "203.0.113.10",
        dkimSelector: "paas",
        dkimPublicKey: "AAAA",
        dmarcStage: "none",
      }),
      verify: async () => ({ ptr: { ip: "203.0.113.10", expected: "x", status: "found", found: ["x"], ticketText: null } }) as never,
      tls: async () => ({ checkedAt: "x", serverRunning: true, syncError: null, hosts: [] }),
      blacklist: async () => null,
      queue: async () => [],
      probePort25: async () => ({ status: "open" }),
      isProxyIp: () => false,
    });
    const report = await service.check("envio.exemplo.com.br", { manual: false });
    expect(servers.flat().sort()).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
    expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ code: "unreachable", inbox: false });
  });
});
