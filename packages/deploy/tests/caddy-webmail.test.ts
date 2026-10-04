/**
 * Caddyfile com o webmail (pedido do dono do produto, 04/10/2026): com o
 * webmail ativado, o bloco de cada mail.<domínio> encaminha para o container
 * do Roundcube; desativado, continua a página "Servidor de e-mail". O bloco
 * é o mesmo nos dois casos — é ele que faz o Caddy emitir o certificado que
 * o painel copia para o Stalwart, então o nome continua lá.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { CaddyManager, WEBMAIL_BLOCKED_PAGE, WEBMAIL_DOWN_PAGE, renderCaddyfile } from "../src/caddy.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

function blockOf(out: string, host: string): string {
  const start = out.indexOf(`${host} {`);
  return out.slice(start, out.indexOf("\n}\n", start) + 2);
}

describe("renderCaddyfile — webmail", () => {
  it("desativado: a página do servidor de e-mail (como antes)", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com.br"]);
    expect(blockOf(out, "mail.exemplo.com.br")).toContain("Servidor de e-mail");
    expect(out).not.toContain("reverse_proxy");
  });

  it("ativado: o mesmo nome encaminha para o webmail, com cabeçalhos de segurança", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com.br", "mail.outro.com"], [], {
      webmail: { upstream: "paas-webmail:8000" },
    });
    for (const host of ["mail.exemplo.com.br", "mail.outro.com"]) {
      const bloco = blockOf(out, host);
      expect(bloco).toContain("\treverse_proxy paas-webmail:8000 {");
      expect(bloco).toContain("\t\theader_down -Server");
      expect(bloco).toContain("\t\theader_down -X-Powered-By");
      expect(bloco).toContain('\t\tStrict-Transport-Security "max-age=31536000"');
      expect(bloco).toContain('\t\tX-Content-Type-Options "nosniff"');
      expect(bloco).toContain('\t\tReferrer-Policy "no-referrer"');
      expect(bloco).toContain("Permissions-Policy");
      // webmail fora do ar: página amigável, não o erro cru do proxy
      expect(bloco).toContain("handle_errors 502 503 504 {");
      expect(bloco).toContain("Webmail");
      expect(bloco).not.toContain("Servidor de e-mail");
    }
    // nada de http:// na frente: o certificado continua sendo emitido
    expect(out).not.toContain("http://mail.");
  });

  it("IPs bloqueados por excesso de senhas erradas recebem 429 antes do webmail", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com"], [], {
      webmail: { upstream: "paas-webmail:8000", blockedIps: ["203.0.113.7", "2001:db8::1", "nao-e-ip", "1.2.3.4 {"] },
    });
    const bloco = blockOf(out, "mail.exemplo.com");
    expect(bloco).toContain("\t@webmail_bloqueado remote_ip 203.0.113.7 2001:db8::1\n");
    expect(bloco).toContain('\theader @webmail_bloqueado Content-Type "text/html; charset=utf-8"');
    expect(bloco).toMatch(/\trespond @webmail_bloqueado `[\s\S]*` 429/);
    expect(bloco.indexOf("@webmail_bloqueado remote_ip")).toBeLessThan(bloco.indexOf("reverse_proxy"));
    expect(bloco).not.toContain("nao-e-ip");
  });

  it("sem IP bloqueado válido: sem matcher (remote_ip vazio derrubaria o Caddyfile)", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com"], [], {
      webmail: { upstream: "paas-webmail:8000", blockedIps: ["lixo"] },
    });
    expect(out).not.toContain("@webmail_bloqueado");
  });

  it("certificado manual do nome continua valendo com o webmail", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com"], ["mail.exemplo.com"], {
      webmail: { upstream: "paas-webmail:8000" },
    });
    const bloco = blockOf(out, "mail.exemplo.com");
    expect(bloco).toContain("\ttls /etc/caddy/certs/mail-exemplo-com.crt /etc/caddy/certs/mail-exemplo-com.key");
    expect(bloco).toContain("reverse_proxy paas-webmail:8000");
  });

  it("nome que já é de um site não vira webmail (o site continua)", () => {
    const out = renderCaddyfile(
      [{ domain: "mail.exemplo.com", upstream: "site:80", websocket: false }],
      undefined,
      ["mail.exemplo.com"],
      [],
      { webmail: { upstream: "paas-webmail:8000" } },
    );
    expect(out).not.toContain("paas-webmail");
  });

  it("upstream fora do formato: fica a página do servidor de e-mail", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com"], [], { webmail: { upstream: "x {\n}" } });
    expect(out).not.toContain("reverse_proxy");
    expect(out).toContain("Servidor de e-mail");
  });

  it("as páginas não têm chaves nem crases", () => {
    expect(WEBMAIL_DOWN_PAGE).not.toMatch(/[{}`]/);
    expect(WEBMAIL_BLOCKED_PAGE).not.toMatch(/[{}`]/);
  });
});

describe("CaddyManager.apply / DeployEngine.syncCaddy — webmail", () => {
  let dir = "";
  const base = (): EngineContext => ({
    projectsDir: dir,
    caddyDir: path.join(dir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    mailHosts: async () => ["mail.exemplo.com"],
  });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-webmail-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("o motor pergunta pelo webmail a cada sincronização e repassa ao Caddy", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const webmail = vi.fn(async () => ({ upstream: "paas-webmail:8000", blockedIps: ["203.0.113.7"] }));
    await new DeployEngine({ ...base(), webmail }).syncCaddy([] as Project[]);
    expect(webmail).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([], undefined, ["mail.exemplo.com"], {
      manual: [],
      force: false,
      webmail: { upstream: "paas-webmail:8000", blockedIps: ["203.0.113.7"] },
    });
  });

  it("webmail desativado (null) ou provedor que falha: segue sem ele, sem derrubar os sites", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    await new DeployEngine({ ...base(), webmail: async () => null }).syncCaddy([]);
    expect(apply.mock.calls[0]![3]).toEqual({ manual: [], force: false });
    const logs: string[] = [];
    await new DeployEngine({
      ...base(),
      webmail: async () => {
        throw new Error("webmail.json ilegível");
      },
    }).syncCaddy([], (c) => logs.push(c));
    expect(apply.mock.calls[1]![3]).toEqual({ manual: [], force: false });
    expect(logs.join("")).toContain("webmail.json ilegível");
  });
});
