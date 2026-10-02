/**
 * Caddyfile com o hostname do servidor de e-mail (mail.<domínio>).
 *
 * Validação real (01/10/2026): o Stalwart usava certificado autoassinado e o
 * app do projeto (nodemailer com verificação padrão) recusava a conexão. O
 * Caddy central — que já emite os certificados dos sites — passa a emitir
 * também o de mail.<domínio>: entra um bloco para esse nome, respondendo uma
 * página simples, e o painel copia o certificado para o Stalwart.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { CaddyManager, MAIL_HOST_PAGE, renderCaddyfile } from "../src/caddy.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

describe("renderCaddyfile — servidor de e-mail", () => {
  it("um bloco por mail.<domínio>, com HTTPS automático e a página do servidor de e-mail", () => {
    const out = renderCaddyfile([], undefined, ["mail.exemplo.com.br", "mail.outro.com"]);
    const bloco = out.slice(out.indexOf("mail.exemplo.com.br {"), out.indexOf("mail.outro.com {"));
    expect(bloco).toContain('header Content-Type "text/html; charset=utf-8"');
    expect(bloco).toContain("Servidor de e-mail");
    expect(bloco).toMatch(/respond `[\s\S]*` 200/);
    expect(out).toContain("mail.outro.com {");
    // nada de http:// na frente: é o endereço sem esquema que faz o Caddy emitir o certificado
    expect(out).not.toContain("http://mail.");
  });

  it("a página não tem chaves nem crases (o Caddy as leria como variável/fim de texto)", () => {
    expect(MAIL_HOST_PAGE).not.toMatch(/[{}`]/);
  });

  it("nome igual ao de um projeto ou ao do painel: o bloco de e-mail sai (o certificado já é emitido pelo bloco existente)", () => {
    const out = renderCaddyfile(
      [{ domain: "mail.exemplo.com.br", upstream: "site:80", websocket: false }],
      { domain: "mail.painel.com", upstream: "tws-panel:9000" },
      ["mail.exemplo.com.br", "mail.painel.com", "mail.outro.com"],
    );
    expect(out.match(/^mail\.exemplo\.com\.br \{/gm)).toHaveLength(1);
    expect(out.match(/^mail\.painel\.com \{/gm)).toHaveLength(1);
    expect(out).toContain("mail.outro.com {");
  });

  it("alias de projeto com o mesmo nome também conta; nomes repetidos ou fora do formato saem", () => {
    const out = renderCaddyfile(
      [{ domain: "site.com", aliases: ["mail.site.com"], upstream: "site:80", websocket: false }],
      undefined,
      ["mail.site.com", "mail.ok.com", "mail.ok.com", "mail.ok.com {\n}", "mail.localhost"],
    );
    expect(out.match(/mail\.site\.com/g)).toHaveLength(1);
    expect(out.match(/^mail\.ok\.com \{/gm)).toHaveLength(1);
    expect(out).not.toContain("mail.ok.com {\n}");
    // .localhost não tem certificado público: não entra
    expect(out).not.toContain("mail.localhost");
  });
});

describe("CaddyManager.apply / DeployEngine.syncCaddy — hosts de e-mail", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-mail-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("o motor pede os hosts de e-mail a cada sincronização e repassa ao Caddy", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const mailHosts = vi.fn(async () => ["mail.exemplo.com.br"]);
    const ctx: EngineContext = {
      projectsDir: dir,
      caddyDir: path.join(dir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      mailHosts,
    };
    await new DeployEngine(ctx).syncCaddy([] as Project[]);
    expect(mailHosts).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([], undefined, ["mail.exemplo.com.br"], { manual: [], force: false });
  });

  it("provedor de hosts que falha não derruba o proxy dos sites (segue sem o bloco de e-mail)", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const logs: string[] = [];
    const ctx: EngineContext = {
      projectsDir: dir,
      caddyDir: path.join(dir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      mailHosts: async () => {
        throw new Error("mail.json ilegível");
      },
    };
    await new DeployEngine(ctx).syncCaddy([], (c) => logs.push(c));
    expect(apply.mock.calls[0]![2]).toEqual([]);
    expect(logs.join("")).toContain("mail.json ilegível");
  });

  it("sem provedor (e-mail nunca configurado): lista vazia", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const ctx: EngineContext = {
      projectsDir: dir,
      caddyDir: path.join(dir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    };
    await new DeployEngine(ctx).syncCaddy([]);
    expect(apply.mock.calls[0]![2]).toEqual([]);
  });
});
