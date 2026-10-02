/**
 * Certificado manual (página Certificados) e "Tentar emitir agora".
 *
 * Manual: o nome ganha um bloco só dele com `tls <cert> <key>`; os arquivos
 * vão para dentro do container do Caddy pelo MESMO caminho do Caddyfile
 * (docker cp para /etc/caddy, pasta certs/ 0700, arquivos 0600) — nunca por
 * bind mount. Os outros nomes do mesmo projeto continuam no automático.
 *
 * Emitir agora: `caddy reload --force` recarrega mesmo com a configuração
 * igual; o certmagic recomeça a emissão dos nomes sem certificado sem esperar
 * o intervalo crescente (certificados válidos não são tocados).
 *
 * Sem Docker: `run` e `copyFilesToContainer` são dublês.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ code: 1, stdout: "", stderr });

const calls: string[][] = [];
let responder: (args: string[]) => Result = () => ok();

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return responder(args);
  }),
}));

const copies: { container: string; dest: string; files: { name: string; content?: string | Buffer; mode?: number }[] }[] = [];
vi.mock("../src/container-files.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/container-files.js")>();
  return {
    ...real,
    copyFilesToContainer: vi.fn(async (container: string, dest: string, files: never[]) => {
      copies.push({ container, dest, files });
      return ok();
    }),
  };
});

const { CaddyManager, renderCaddyfile, manualCertificatePaths } = await import("../src/caddy.js");
const { DeployEngine } = await import("../src/engine.js");

const NEW = JSON.stringify([{ Type: "volume", Destination: "/data" }]);
const running = (args: string[]): Result =>
  args[0] === "inspect" && args[2] === "{{.State.Running}}|{{json .Mounts}}"
    ? ok(`true|${NEW}\n`)
    : args[0] === "inspect"
      ? ok(`true|${NEW}\n`)
      : ok();

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-manual-"));
  calls.length = 0;
  copies.length = 0;
  responder = running;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("renderCaddyfile — certificado manual", () => {
  it("nome manual sai do bloco automático e ganha bloco próprio com tls <cert> <key>", () => {
    const out = renderCaddyfile(
      [{ domain: "loja.exemplo.com.br", aliases: ["www.exemplo.com.br"], upstream: "loja:3000", websocket: false }],
      undefined,
      [],
      ["www.exemplo.com.br"],
    );
    const p = manualCertificatePaths("www.exemplo.com.br");
    expect(out).toMatch(/^loja\.exemplo\.com\.br \{/m);
    expect(out).not.toMatch(/^loja\.exemplo\.com\.br, www/m);
    const bloco = out.slice(out.indexOf("www.exemplo.com.br {"));
    expect(bloco).toContain(`\ttls ${p.cert} ${p.key}`);
    expect(bloco).toContain("reverse_proxy loja:3000");
    expect(p.cert).toBe("/etc/caddy/certs/www-exemplo-com-br.crt");
    expect(p.key).toBe("/etc/caddy/certs/www-exemplo-com-br.key");
    // o bloco automático não tem tls
    const auto = out.slice(out.indexOf("loja.exemplo.com.br {"), out.indexOf("www.exemplo.com.br {"));
    expect(auto).not.toContain("tls ");
  });

  it("todos os nomes do alvo manuais: nenhum bloco automático vazio", () => {
    const out = renderCaddyfile(
      [{ domain: "loja.exemplo.com.br", upstream: "loja:3000", websocket: true }],
      undefined,
      [],
      ["loja.exemplo.com.br"],
    );
    expect(out.match(/^loja\.exemplo\.com\.br \{/gm)).toHaveLength(1);
    expect(out).toContain("flush_interval -1");
    expect(out).toContain("tls /etc/caddy/certs/loja-exemplo-com-br.crt");
  });

  it("painel e mail.<domínio> também aceitam manual", () => {
    const out = renderCaddyfile(
      [],
      { domain: "painel.exemplo.com.br", upstream: "tws-panel:9000" },
      ["mail.exemplo.com.br"],
      ["painel.exemplo.com.br", "mail.exemplo.com.br"],
    );
    expect(out).toContain("tls /etc/caddy/certs/painel-exemplo-com-br.crt /etc/caddy/certs/painel-exemplo-com-br.key");
    expect(out).toContain("tls /etc/caddy/certs/mail-exemplo-com-br.crt /etc/caddy/certs/mail-exemplo-com-br.key");
    // o painel continua sem a página de erro dos projetos
    const painel = out.slice(out.indexOf("painel.exemplo.com.br {"), out.indexOf("mail.exemplo.com.br {"));
    expect(painel).not.toContain("handle_errors");
  });

  it("sem manuais: Caddyfile igual ao de antes (nenhuma diretiva tls)", () => {
    const out = renderCaddyfile([{ domain: "a.exemplo.com.br", upstream: "a:80", websocket: false }]);
    expect(out).not.toMatch(/\ttls /);
  });

  it("nome manual fora do formato é ignorado (não vira diretiva)", () => {
    const out = renderCaddyfile([{ domain: "a.exemplo.com.br", upstream: "a:80", websocket: false }], undefined, [], ["a.exemplo.com.br {\n}"]);
    expect(out).not.toMatch(/\ttls /);
  });
});

describe("CaddyManager.apply — arquivos do certificado manual e reload forçado", () => {
  const manual = [{ host: "loja.exemplo.com.br", cert: "-----BEGIN CERTIFICATE-----\nX\n", key: `${"-----BEGIN"} FAKE KEY-----\nY\n` }];

  it("grava Caddyfile + certs/ (0700) + .crt/.key (0600) na mesma cópia para /etc/caddy", async () => {
    await new CaddyManager(path.join(dir, "caddy")).apply(
      [{ domain: "loja.exemplo.com.br", upstream: "loja:3000", websocket: false }],
      undefined,
      [],
      { manual },
    );
    const last = copies.at(-1)!;
    expect(last.dest).toBe("/etc/caddy");
    const byName = Object.fromEntries(last.files.map((f) => [f.name, f]));
    expect(byName["Caddyfile"]).toBeDefined();
    expect(byName["certs/"]?.mode).toBe(0o700);
    expect(byName["certs/loja-exemplo-com-br.crt"]?.mode).toBe(0o600);
    expect(byName["certs/loja-exemplo-com-br.key"]?.mode).toBe(0o600);
    expect(byName["certs/loja-exemplo-com-br.key"]?.content).toBe(manual[0]!.key);
    expect(String(byName["Caddyfile"]!.content)).toContain("tls /etc/caddy/certs/loja-exemplo-com-br.crt");
  });

  it("a chave nunca vai para o espelho local nem para o log", async () => {
    const logs: string[] = [];
    await new CaddyManager(path.join(dir, "caddy")).apply(
      [{ domain: "loja.exemplo.com.br", upstream: "loja:3000", websocket: false }],
      (c) => logs.push(c),
      [],
      { manual },
    );
    expect(logs.join("")).not.toContain("FAKE KEY");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(dir, "caddy"))).toEqual(["Caddyfile"]);
  });

  it("force: caddy reload --force; sem force, reload normal", async () => {
    const m = new CaddyManager(path.join(dir, "caddy"));
    await m.apply([], undefined, [], { force: true });
    const reload = calls.find((a) => a.includes("reload"))!;
    expect(reload).toContain("--force");
    calls.length = 0;
    await m.apply([], undefined, []);
    expect(calls.find((a) => a.includes("reload"))).not.toContain("--force");
  });

  it("removeManualFiles apaga só os arquivos daquele nome dentro do container", async () => {
    await new CaddyManager(path.join(dir, "caddy")).removeManualFiles("loja.exemplo.com.br");
    expect(calls.at(-1)).toEqual([
      "exec",
      "paas-caddy",
      "rm",
      "-f",
      "/etc/caddy/certs/loja-exemplo-com-br.crt",
      "/etc/caddy/certs/loja-exemplo-com-br.key",
    ]);
  });

  it("removeManualFiles recusa nome fora do formato", async () => {
    await expect(new CaddyManager(dir).removeManualFiles("../../x")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("recentLogs: docker logs --since 24h, junta saída e erro (o Caddy loga no stderr)", async () => {
    responder = (a) => (a[0] === "logs" ? { code: 0, stdout: "linha1\n", stderr: "linha2\n" } : ok());
    const text = await new CaddyManager(dir).recentLogs();
    expect(calls.at(-1)).toEqual(["logs", "--since", "24h", "--tail", "20000", "paas-caddy"]);
    expect(text).toContain("linha1");
    expect(text).toContain("linha2");
  });

  it("recentLogs: container ausente → texto vazio", async () => {
    responder = (a) => (a[0] === "logs" ? fail("No such container") : ok());
    expect(await new CaddyManager(dir).recentLogs()).toBe("");
  });
});

describe("DeployEngine — certificados manuais e reload forçado", () => {
  const ctxBase = () => ({
    projectsDir: dir,
    caddyDir: path.join(dir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  });

  it("syncCaddy pede os manuais a cada sincronização e repassa (com force quando pedido)", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const manual = [{ host: "a.exemplo.com.br", cert: "c", key: "k" }];
    const manualCertificates = vi.fn(async () => manual);
    const engine = new DeployEngine({ ...ctxBase(), manualCertificates });
    await engine.syncCaddy([] as Project[], undefined, { force: true });
    expect(manualCertificates).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![3]).toEqual({ manual, force: true });
  });

  it("provedor de manuais que falha não derruba o proxy (segue sem eles)", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const logs: string[] = [];
    const engine = new DeployEngine({
      ...ctxBase(),
      manualCertificates: async () => {
        throw new Error("ilegível");
      },
    });
    await engine.syncCaddy([], (c) => logs.push(c));
    expect(apply.mock.calls[0]![3]).toEqual({ manual: [], force: false });
    expect(logs.join("")).toContain("ilegível");
  });
});
