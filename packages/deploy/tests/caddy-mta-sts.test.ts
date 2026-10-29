/**
 * Política MTA-STS publicada pelo próprio proxy: um bloco por domínio de e-mail
 * (mta-sts.<domínio>) com certificado sob demanda, só o caminho
 * /.well-known/mta-sts.txt respondendo (text/plain) e as defesas contra nome
 * repetido ou texto que quebraria o Caddyfile.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { CaddyManager, renderCaddyfile, type CaddyDynamic } from "../src/caddy.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

const ASK = "http://tws-panel:9101/caddy/ask";
const POLICY = "version: STSv1\r\nmode: testing\r\nmx: mail.example.com\r\nmax_age: 86400\r\n";

function dyn(mtaSts: CaddyDynamic["mtaSts"], routes: CaddyDynamic["routes"] = []): { dynamic: CaddyDynamic } {
  return { dynamic: { askUrl: ASK, routes, ...(mtaSts ? { mtaSts } : {}) } };
}

describe("renderCaddyfile — política MTA-STS", () => {
  it("gera o bloco com certificado sob demanda, o arquivo em text/plain e 404 no resto", () => {
    const out = renderCaddyfile([], undefined, [], [], dyn([{ host: "mta-sts.example.com", policy: POLICY }]));
    expect(out).toContain("{\n\ton_demand_tls {\n\t\task http://tws-panel:9101/caddy/ask\n\t}\n}");
    expect(out).toContain("mta-sts.example.com {\n\ttls {\n\t\ton_demand\n\t}\n\thandle /.well-known/mta-sts.txt {");
    expect(out).toContain('header Content-Type "text/plain; charset=utf-8"');
    expect(out).toContain("respond `version: STSv1\nmode: testing\nmx: mail.example.com\nmax_age: 86400\n` 200");
    expect(out).toContain('handle {\n\t\trespond "Not found" 404');
    // o fallback de domínio desconhecido continua por último
    expect(out.indexOf("mta-sts.example.com {")).toBeLessThan(out.indexOf("http:// {"));
  });

  it("sem lista de políticas (ou vazia) e sem rotas, nada é gerado: nem a opção global", () => {
    expect(renderCaddyfile([], undefined, [], [], dyn(undefined))).not.toContain("on_demand");
    expect(renderCaddyfile([], undefined, [], [], dyn([]))).not.toContain("on_demand");
  });

  it("convive com as rotas dinâmicas dos projetos: uma opção global só", () => {
    const out = renderCaddyfile(
      [],
      undefined,
      [],
      [],
      dyn([{ host: "mta-sts.example.com", policy: POLICY }], [{ upstream: "saas:80", websocket: false, suffixes: ["example.org"], hosts: [] }]),
    );
    expect(out.match(/on_demand_tls \{/g)).toHaveLength(1);
    expect(out).toContain("*.example.org {");
    expect(out).toContain("mta-sts.example.com {");
  });

  it("nome repetido, já servido, fora do padrão mta-sts. ou .localhost sai (dois blocos iguais derrubariam o Caddyfile)", () => {
    const out = renderCaddyfile(
      [{ domain: "mta-sts.ja-servido.example", upstream: "x:80", websocket: false }],
      undefined,
      [],
      [],
      dyn([
        { host: "mta-sts.example.com", policy: POLICY },
        { host: "MTA-STS.example.com", policy: POLICY },
        { host: "mta-sts.ja-servido.example", policy: POLICY },
        { host: "outro.example.com", policy: POLICY },
        { host: "mta-sts.casa.localhost", policy: POLICY },
        { host: "mta-sts.exemplo..com", policy: POLICY },
      ]),
    );
    expect(out.match(/^mta-sts\.example\.com \{/gm)).toHaveLength(1);
    expect(out.match(/^mta-sts\.ja-servido\.example \{/gm)).toHaveLength(1);
    expect(out).toContain("reverse_proxy x:80");
    expect(out).not.toContain("outro.example.com {");
    expect(out).not.toContain("casa.localhost {");
    expect(out).not.toContain("exemplo..com");
  });

  it("texto da política que poderia fechar o bloco do Caddyfile é recusado", () => {
    for (const policy of ["version: STSv1`\n}\nevil.example { respond `x", "version: STSv1\n}\nmx: a", "", "a: b\n\n\nc: d"]) {
      const out = renderCaddyfile([], undefined, [], [], dyn([{ host: "mta-sts.example.com", policy }]));
      expect(out, policy).not.toContain("mta-sts.example.com {");
    }
  });

  it("o endereço do ask continua sendo conferido: URL insegura não gera nada", () => {
    const out = renderCaddyfile([], undefined, [], [], { dynamic: { askUrl: "http://x/\nevil", routes: [], mtaSts: [{ host: "mta-sts.example.com", policy: POLICY }] } });
    expect(out).not.toContain("mta-sts.example.com {");
  });
});

describe("DeployEngine — política MTA-STS no proxy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-mtasts-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const base = (extra: Partial<EngineContext> = {}): EngineContext => ({
    projectsDir: dir,
    caddyDir: path.join(dir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    ...extra,
  });

  it("repassa as políticas ao Caddy mesmo sem nenhum domínio dinâmico de projeto", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(
      base({ dynamicDomains: async () => ({ askUrl: ASK, projects: [], mtaSts: [{ host: "mta-sts.example.com", policy: POLICY }] }) }),
    );
    await engine.syncCaddy([]);
    expect(apply.mock.calls[0]![3]!.dynamic).toEqual({ askUrl: ASK, routes: [], mtaSts: [{ host: "mta-sts.example.com", policy: POLICY }] });
  });

  it("sem política e sem rota, nem a opção dynamic", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    await new DeployEngine(base({ dynamicDomains: async () => ({ askUrl: ASK, projects: [] }) })).syncCaddy([] as Project[]);
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("dynamic");
  });
});
