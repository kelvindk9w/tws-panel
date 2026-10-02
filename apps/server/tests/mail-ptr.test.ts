/**
 * mail-ptr.test.ts — o DNS reverso (PTR) em três níveis chega ao resumo do
 * domínio (lista de domínios e roteiro de primeiros passos usam lastVerify).
 *
 * Validação real (01/10/2026): VPS na Contabo com o PTR genérico
 * vmiNNNNNNN.contaboserver.net, que volta para o mesmo IP. O FCrDNS (o que o
 * Gmail exige) passa; o domínio não pode ficar com "pendências" por isso.
 * Sem Docker e sem DNS: StalwartManager é dublê e o resolver é injetado.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS } from "@paas/core";
import type { DnsResolverLike } from "@paas/mailer";
import type { ServerConfig } from "../src/config.js";

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    async status() {
      return { installed: true, running: true, ports: MAIL_DEFAULT_PORTS };
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager };
});

const { MailService } = await import("../src/services/mail-service.js");

const DKIM = "x".repeat(120);
let dir = "";
let config: ServerConfig;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-ptr-"));
  config = {
    dataDir: dir,
    mailPorts: MAIL_DEFAULT_PORTS,
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({
      adminSecret: "s",
      hostname: null,
      domains: {
        "envio.exemplo.com.br": {
          name: "envio.exemplo.com.br",
          dkimSelector: "paas",
          dkimPublicKey: DKIM,
          dkimKeyBits: 2048,
          dmarcStage: "none",
          createdAt: new Date(0).toISOString(),
          lastVerify: null,
        },
      },
      mailboxes: {},
      projects: {},
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function resolver(ptr: string[], a: Record<string, string[]>): DnsResolverLike {
  const domain = "envio.exemplo.com.br";
  return {
    resolve4: async (name) => a[name] ?? [],
    resolve6: async () => [],
    resolveMx: async () => [{ exchange: `mail.${domain}.`, priority: 10 }],
    resolveTxt: async (name) => {
      if (name === domain) return [["v=spf1 ip4:203.0.113.10 ~all"]];
      if (name.startsWith("paas._domainkey.")) return [[`v=DKIM1; k=rsa; p=${DKIM}`]];
      return [[`v=DMARC1; p=none; rua=mailto:dmarc@${domain}`]];
    },
    reverse: async () => ptr,
  };
}

describe("verificação do domínio com o PTR genérico do provedor", () => {
  it("PTR da Contabo que volta para o IP: azul, conta como OK e o domínio fica sem pendências", async () => {
    const service = new MailService(config, {
      inContainer: false,
      resolver: resolver(["vmi1234567.contaboserver.net"], {
        "mail.envio.exemplo.com.br": ["203.0.113.10"],
        "vmi1234567.contaboserver.net": ["203.0.113.10"],
      }),
    });

    const result = await service.verifyDomain("envio.exemplo.com.br");
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.provider?.id).toBe("contabo");
    expect(result.summary).toEqual({ ok: 6, total: 6 });

    const [summary] = await service.listDomains();
    expect(summary?.lastVerify).toMatchObject({ ok: 6, total: 6 });
    const stored = JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8"));
    expect(stored.domains["envio.exemplo.com.br"].lastVerify).toMatchObject({ ok: 6, total: 6 });
  });

  it("PTR que não volta para o IP: amarelo e fica uma pendência", async () => {
    const service = new MailService(config, {
      inContainer: false,
      resolver: resolver(["vmi1234567.contaboserver.net"], { "mail.envio.exemplo.com.br": ["203.0.113.10"] }),
    });
    const result = await service.verifyDomain("envio.exemplo.com.br");
    expect(result.ptr.status).toBe("mismatch");
    expect(result.summary).toEqual({ ok: 5, total: 6 });
  });
});
