/**
 * StalwartManager.start — config.toml entregue pelo daemon, não por bind mount.
 *
 * Defeito: o container era criado com `-v <dataDir>/mail/stalwart:/opt/stalwart-mail/etc:ro`.
 * Com o painel em container (produção), o daemon do HOST não conhece esse
 * caminho e monta um diretório vazio: o entrypoint da imagem não acha
 * config.toml, roda `--init` e o servidor sobe com configuração padrão (sem o
 * fallback-admin do painel). Reproduzido com Docker real (ver relato). Agora
 * o arquivo vai para dentro do container com `docker cp` antes do start, e um
 * container com a montagem antiga é recriado.
 *
 * Sem Docker: `run` e `copyFilesToContainer` são substituídos por dublês.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const { StalwartManager } = await import("../src/server.js");

const LEGACY = JSON.stringify([
  { Type: "volume", Destination: "/opt/stalwart-mail/data" },
  { Type: "bind", Source: "/data/mail/stalwart", Destination: "/opt/stalwart-mail/etc" },
]);
const NEW = JSON.stringify([
  { Type: "volume", Destination: "/opt/stalwart-mail" },
  { Type: "volume", Destination: "/opt/stalwart-mail/data" },
]);

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
const ports = { smtp: 25, submission: 587, submissions: 465, imap: 143, imaps: 993, http: 8080 };
const manager = (extra: Record<string, string> = {}) =>
  new StalwartManager({ configDir: path.join(dir, "stalwart"), hostname: "mail.exemplo.com", adminSecret: "s3gredo", ports, ...extra });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-stalwart-manager-"));
  calls.length = 0;
  copies.length = 0;
  copyResult = ok();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ordem = () => calls.map((a) => a[0]);

describe("StalwartManager.start — criação", () => {
  it("cria sem bind mount do diretório do painel e entrega o config.toml antes do start", async () => {
    responder = daemon(null);
    await manager().start();

    expect(ordem()).toEqual(["network", "inspect", "create", "<cp>", "start"]);
    const create = calls.find((a) => a[0] === "create")!;
    const volumes = create.flatMap((a, i) => (create[i - 1] === "-v" ? [a] : []));
    expect(volumes).toEqual(["paas_stalwart_data:/opt/stalwart-mail/data"]);
    expect(create.join(" ")).not.toContain(dir);
    expect(create.join(" ")).not.toContain("/opt/stalwart-mail/etc");

    const cp = copies[0]!;
    expect(cp.container).toBe("paas-stalwart");
    expect(cp.dest).toBe("/opt/stalwart-mail");
    expect(cp.files.map((f) => f.name)).toEqual(["etc/", "etc/config.toml"]);
    expect(cp.files[1]!.mode).toBe(0o600);
    expect(String(cp.files[1]!.content)).toContain('server.hostname = "mail.exemplo.com"');
    expect(String(cp.files[1]!.content)).toContain('secret = "s3gredo"');

    // espelho local mantido (retrocompatível com writeConfig)
    expect(await readFile(path.join(dir, "stalwart", "config.toml"), "utf8")).toContain("mail.exemplo.com");
  });

  it("aceita nome, rede e volume configuráveis", async () => {
    responder = daemon(null);
    await manager({ containerName: "x-stalwart", network: "x-net", dataVolume: "x_data" }).start();
    const create = calls.find((a) => a[0] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["x-stalwart", "x-net", "x_data:/opt/stalwart-mail/data"]));
    expect(copies[0]!.container).toBe("x-stalwart");
  });

  it("cria a rede ausente; falha ao criá-la é erro claro", async () => {
    responder = daemon(null, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : undefined));
    await manager().start();
    expect(calls[1]).toEqual(["network", "create", "--label", "paas.managed=true", "paas-net"]);

    responder = daemon(null, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : a[0] === "network" ? fail("negado") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao criar a rede paas-net: negado/);
  });

  it("propaga falhas de create, cp e start", async () => {
    responder = daemon(null, (a) => (a[0] === "create" ? fail("conflito") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao criar paas-stalwart: conflito/);

    responder = daemon(null);
    copyResult = fail("sem espaço\n");
    await expect(manager().start()).rejects.toThrow(/falha ao gravar a configuração em paas-stalwart: sem espaço$/);

    copyResult = ok();
    responder = daemon(null, (a) => (a[0] === "start" ? fail("porta 25 ocupada") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao iniciar paas-stalwart: porta 25 ocupada/);
  });
});

describe("StalwartManager.start — container existente", () => {
  it("parado com montagem nova: regrava a config e inicia", async () => {
    responder = daemon({ running: false, mounts: NEW });
    await manager().start();
    expect(ordem()).toEqual(["network", "inspect", "<cp>", "start"]);
  });

  it("rodando com montagem nova: regrava a config e não recria", async () => {
    responder = daemon({ running: true, mounts: NEW });
    await manager().start();
    expect(ordem()).toEqual(["network", "inspect", "<cp>"]);
  });

  it("start responde 'already in use': considera no ar", async () => {
    responder = daemon({ running: false, mounts: NEW }, (a) => (a[0] === "start" ? fail("container already in use") : undefined));
    await manager().start();
    expect(ordem()).toEqual(["network", "inspect", "<cp>", "start"]);
  });

  it("start falha por outro motivo: remove (com o volume anônimo) e recria", async () => {
    let starts = 0;
    responder = daemon({ running: false, mounts: NEW }, (a) => (a[0] === "start" && starts++ === 0 ? fail("imagem antiga") : undefined));
    await manager().start();
    expect(ordem()).toEqual(["network", "inspect", "<cp>", "start", "rm", "create", "<cp>", "start"]);
    expect(calls.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", "paas-stalwart"]);
  });

  it.each([
    ["parado (produção: etc vazio no host)", false],
    ["rodando (desenvolvimento)", true],
  ])("montagem ANTIGA %s: remove e recria com a config entregue pelo daemon", async (_n, running) => {
    responder = daemon({ running, mounts: LEGACY });
    await manager().start();
    expect(ordem()).toEqual(["network", "inspect", "rm", "create", "<cp>", "start"]);
    expect(calls.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", "paas-stalwart"]);
  });
});
