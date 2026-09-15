/**
 * CaddyManager — Caddyfile entregue pelo daemon, não por bind mount.
 *
 * Defeito: o container do Caddy era criado com
 * `-v <dataDir>/caddy/Caddyfile:/etc/caddy/Caddyfile:ro`. Em produção o painel
 * roda em container e `<dataDir>` é um volume nomeado: o daemon do HOST não
 * acha o caminho, cria um diretório vazio no lugar e o Caddy não sobe; as
 * recargas gravavam um arquivo que o Caddy nunca via. Reproduzido com Docker
 * real (ver relato da correção). Agora o arquivo vai para dentro do container
 * com `docker cp`, e um container com a montagem antiga é recriado.
 *
 * Sem Docker: `run` e `copyFilesToContainer` são substituídos por dublês.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ code: 1, stdout: "", stderr });

const calls: string[][] = [];
let responder: (args: string[]) => Result;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return responder(args);
  }),
}));

const copies: { container: string; dest: string; files: { name: string; content?: string | Buffer; mode?: number }[] }[] = [];
let copyResult: Result = ok();
vi.mock("../src/container-files.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/container-files.js")>();
  return {
    ...real,
    copyFilesToContainer: vi.fn(async (container: string, dest: string, files: never[]) => {
      copies.push({ container, dest, files });
      calls.push(["<cp>", container, dest]);
      return copyResult;
    }),
  };
});

const { CaddyManager } = await import("../src/caddy.js");

const LEGACY = JSON.stringify([
  { Type: "bind", Source: "/data/caddy/Caddyfile", Destination: "/etc/caddy/Caddyfile" },
  { Type: "volume", Destination: "/data" },
]);
const NEW = JSON.stringify([
  { Type: "volume", Destination: "/data" },
  { Type: "volume", Destination: "/config" },
]);

/** Estado simulado do container: null = não existe. */
function daemon(state: { running: boolean; mounts: string } | null, extra: (a: string[]) => Result | undefined = () => undefined) {
  return (args: string[]): Result => {
    const r = extra(args);
    if (r) return r;
    if (args[0] === "network") return ok();
    if (args[0] === "inspect") return state ? ok(`${state.running}|${state.mounts}\n`) : fail("No such object");
    return ok();
  };
}

let dir: string;
const alvo = [{ domain: "loja.example.com", upstream: "paas-loja:3000", websocket: false }];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-manager-"));
  calls.length = 0;
  copies.length = 0;
  copyResult = ok();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manager = () => new CaddyManager(path.join(dir, "caddy"), undefined, { http: 9080, https: 9443 });

describe("CaddyManager — criação do container", () => {
  it("cria sem bind mount de caminho do painel, grava o Caddyfile pelo daemon e só então inicia", async () => {
    responder = daemon(null);
    await manager().ensureRunning();

    const create = calls.find((a) => a[0] === "create");
    expect(create).toBeDefined();
    expect(calls.some((a) => a[0] === "run")).toBe(false);
    const volumes = create!.flatMap((a, i) => (create![i - 1] === "-v" ? [a] : []));
    expect(volumes).toEqual(["paas_caddy_data:/data", "paas_caddy_config:/config"]);
    expect(create!.join(" ")).not.toContain(dir);
    expect(create!.join(" ")).not.toContain("/etc/caddy");
    expect(create).toEqual(expect.arrayContaining(["9080:80", "9443:443", "paas-caddy", "caddy:2-alpine"]));

    const ordem = calls.map((a) => a[0]);
    expect(ordem.indexOf("create")).toBeLessThan(ordem.indexOf("<cp>"));
    expect(ordem.indexOf("<cp>")).toBeLessThan(ordem.indexOf("start"));
    expect(copies[0]!.dest).toBe("/etc/caddy");
    expect(copies[0]!.files[0]!.name).toBe("Caddyfile");
    expect(String(copies[0]!.files[0]!.content)).toContain("respond 404");
  });

  it("aceita nome, rede e volumes configuráveis", async () => {
    responder = daemon(null);
    await new CaddyManager(dir, "caddy:2", undefined, {
      containerName: "x-caddy",
      network: "x-net",
      dataVolume: "x_data",
      configVolume: "x_config",
    }).ensureRunning("conteudo");
    const create = calls.find((a) => a[0] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["x-caddy", "x-net", "x_data:/data", "x_config:/config", "80:80", "443:443"]));
    expect(copies[0]!.container).toBe("x-caddy");
    expect(copies[0]!.files[0]!.content).toBe("conteudo");
  });

  it("cria a rede quando ela não existe e falha com mensagem clara se não conseguir", async () => {
    responder = daemon(null, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : a[0] === "network" ? fail("sem permissão") : undefined));
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao criar a rede paas-net: sem permissão/);
  });

  it("propaga falha do docker create, do docker cp e do docker start", async () => {
    responder = daemon(null, (a) => (a[0] === "create" ? fail("porta ocupada") : undefined));
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao criar paas-caddy: porta ocupada/);

    responder = daemon(null);
    copyResult = fail("No such container\n");
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao gravar o Caddyfile em paas-caddy: No such container$/);

    copyResult = ok();
    responder = daemon(null, (a) => (a[0] === "start" ? fail("bind: address already in use") : undefined));
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao iniciar paas-caddy/);
  });
});

describe("CaddyManager — container existente", () => {
  it("rodando com a montagem nova: não mexe em nada", async () => {
    responder = daemon({ running: true, mounts: NEW });
    await manager().ensureRunning("x");
    expect(calls.map((a) => a[0])).toEqual(["network", "inspect"]);
  });

  it("parado com a montagem nova: regrava o Caddyfile recebido e inicia", async () => {
    responder = daemon({ running: false, mounts: NEW });
    await manager().ensureRunning("novo");
    expect(calls.map((a) => a[0])).toEqual(["network", "inspect", "<cp>", "start"]);
    expect(copies[0]!.files[0]!.content).toBe("novo");
  });

  it("parado sem conteúdo informado: inicia com o arquivo que já está no container", async () => {
    responder = daemon({ running: false, mounts: NEW });
    await manager().ensureRunning();
    expect(calls.map((a) => a[0])).toEqual(["network", "inspect", "start"]);
  });

  it("parado e o start falha: erro claro", async () => {
    responder = daemon({ running: false, mounts: NEW }, (a) => (a[0] === "start" ? fail("boom") : undefined));
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao iniciar paas-caddy: boom/);
  });

  it.each([
    ["criado e nunca iniciado (produção: diretório vazio no lugar do arquivo)", false],
    ["rodando (desenvolvimento: o caminho existia no host)", true],
  ])("com a montagem ANTIGA %s: remove e recria", async (_nome, running) => {
    responder = daemon({ running, mounts: LEGACY });
    await manager().ensureRunning();
    expect(calls.map((a) => a[0])).toEqual(["network", "inspect", "rm", "create", "<cp>", "start"]);
    expect(calls.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "paas-caddy"]);
  });

  it("montagem antiga e o rm falha: não tenta criar por cima", async () => {
    responder = daemon({ running: false, mounts: LEGACY }, (a) => (a[0] === "rm" ? fail("busy") : undefined));
    await expect(manager().ensureRunning()).rejects.toThrow(/falha ao remover paas-caddy com montagem antiga do Caddyfile: busy/);
    expect(calls.some((a) => a[0] === "create")).toBe(false);
  });
});

describe("CaddyManager.apply — recarga", () => {
  it("grava o conteúdo novo no container e recarrega o arquivo que o Caddy enxerga", async () => {
    responder = daemon({ running: true, mounts: NEW });
    const logs: string[] = [];
    await manager().apply(alvo, (c) => logs.push(c));

    expect(calls.map((a) => a[0])).toEqual(["network", "inspect", "<cp>", "exec"]);
    expect(String(copies[0]!.files[0]!.content)).toContain("reverse_proxy paas-loja:3000");
    expect(calls.at(-1)).toEqual(["exec", "paas-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]);
    expect(logs.join("")).toContain("Caddyfile aplicado com 1 domínio(s)");
    // espelho local para inspeção
    expect(await readFile(path.join(dir, "caddy", "Caddyfile"), "utf8")).toContain("loja.example.com {");
  });

  it("container a criar: nasce já com o Caddyfile dos alvos", async () => {
    responder = daemon(null);
    await manager().apply(alvo);
    expect(String(copies[0]!.files[0]!.content)).toContain("loja.example.com {");
  });

  it("falha ao gravar no container interrompe antes do reload", async () => {
    responder = daemon({ running: true, mounts: NEW });
    copyResult = fail("read-only");
    await expect(manager().apply(alvo)).rejects.toThrow(/falha ao gravar o Caddyfile/);
    expect(calls.some((a) => a[0] === "exec")).toBe(false);
  });

  it("reload falhou: reinicia o container; restart também falhou: erro", async () => {
    responder = daemon({ running: true, mounts: NEW }, (a) => (a[0] === "exec" ? fail("adapt error") : undefined));
    const logs: string[] = [];
    await manager().apply(alvo, (c) => logs.push(c));
    expect(calls.at(-1)).toEqual(["restart", "paas-caddy"]);
    expect(logs.join("")).toMatch(/caddy reload falhou \(adapt error\)/);

    responder = daemon({ running: true, mounts: NEW }, (a) => (a[0] === "exec" || a[0] === "restart" ? fail("x") : undefined));
    await expect(manager().apply(alvo)).rejects.toThrow(/falha ao recarregar o Caddy/);
  });

  it("espelho local ilegível não derruba a aplicação (só avisa)", async () => {
    responder = daemon({ running: true, mounts: NEW });
    const arquivo = path.join(dir, "ocupado");
    await writeFile(arquivo, "sou um arquivo");
    const logs: string[] = [];
    await new CaddyManager(arquivo).apply(alvo, (c) => logs.push(c));
    expect(logs.join("")).toMatch(/aviso: cópia local do Caddyfile não gravada/);
    expect(calls.some((a) => a[0] === "exec")).toBe(true);
    // sem onLog também não lança
    await new CaddyManager(arquivo).apply(alvo);
  });

  it("isRunning e containerName", async () => {
    responder = (a) => (a[0] === "inspect" ? ok("true\n") : ok());
    const m = manager();
    expect(await m.isRunning()).toBe(true);
    expect(m.containerName).toBe("paas-caddy");
  });
});
