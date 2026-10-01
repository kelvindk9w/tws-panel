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

  /**
   * A administração do Stalwart (8080) ficava publicada em todas as interfaces;
   * como o Docker publica por cima do UFW, ela ficava na internet, protegida só
   * pela senha. O painel fala com ela pela paas-net; no host, só 127.0.0.1 (túnel
   * SSH para quem precisar da tela). As portas de e-mail continuam públicas.
   */
  it("administração (8080) só em 127.0.0.1; portas de e-mail públicas", async () => {
    responder = daemon(null);
    await manager().start();
    const create = calls.find((a) => a[0] === "create")!;
    const published = create.flatMap((a, i) => (create[i - 1] === "-p" ? [a] : []));
    expect(published).toContain("127.0.0.1:8080:8080");
    expect(published).not.toContain("8080:8080");
    expect(published).toEqual(expect.arrayContaining(["25:25", "587:587", "465:465", "143:143", "993:993"]));
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

// ---------------------------------------------------------------------------
// Certificado de verdade e alias mail.<domínio> (validação real, 01/10/2026:
// o app do projeto recusava o autoassinado e o nome paas-stalwart).
// ---------------------------------------------------------------------------

const CERT = { host: "mail.exemplo.com", cert: "CERT-PEM", key: "CHAVE-PEM" };
const CERT2 = { host: "mail.outro.com", cert: "CERT2-PEM", key: "CHAVE2-PEM" };
const ALL_ALIASES = JSON.stringify({ "paas-net": { Aliases: ["paas-stalwart", "mail.exemplo.com", "mail.outro.com"] } });
const isNetworksInspect = (a: string[]) => a[0] === "inspect" && (a[2] ?? "").includes("Networks");

const tlsManager = (extra: Record<string, unknown> = {}) =>
  new StalwartManager({
    configDir: path.join(dir, "stalwart"),
    hostname: "mail.exemplo.com",
    adminSecret: "s3gredo",
    ports,
    aliases: ["mail.exemplo.com", "mail.outro.com"],
    certificates: [CERT2, CERT],
    ...extra,
  });

describe("renderConfigToml — certificados", () => {
  it("sem certificado: nenhuma seção [certificate.*] (Stalwart gera o autoassinado)", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    expect(renderConfigToml("mail.exemplo.com", "s")).not.toContain("[certificate.");
  });

  it("uma seção por certificado, lida de arquivo; o do hostname do servidor é o padrão", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.exemplo.com", "s", ["mail.outro.com", "mail.exemplo.com"]);
    expect(toml).toContain(
      [
        "[certificate.mail-exemplo-com]",
        'cert = "%{file:/opt/stalwart-mail/etc/certs/mail-exemplo-com.crt}%"',
        'private-key = "%{file:/opt/stalwart-mail/etc/certs/mail-exemplo-com.key}%"',
        "default = true",
      ].join("\n"),
    );
    expect(toml).toContain("[certificate.mail-outro-com]");
    expect(toml.match(/default = true/g)).toHaveLength(1);
  });

  it("hostname do servidor sem certificado: o primeiro vira o padrão", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.localhost", "s", ["mail.outro.com"]);
    expect(toml).toMatch(/\[certificate\.mail-outro-com\][^[]*default = true/);
  });
});

describe("StalwartManager — certificados e alias", () => {
  it("cria com o alias paas-stalwart E os mail.<domínio>; entrega certificado e chave com modo 0600", async () => {
    responder = daemon(null);
    await tlsManager().start();
    const create = calls.find((a) => a[0] === "create")!;
    const aliases = create.flatMap((a, i) => (create[i - 1] === "--network-alias" ? [a] : []));
    expect(aliases).toEqual(["paas-stalwart", "mail.exemplo.com", "mail.outro.com"]);

    const files = copies[0]!.files;
    expect(files.map((f) => f.name)).toEqual([
      "etc/",
      "etc/config.toml",
      "etc/certs/",
      "etc/certs/mail-outro-com.crt",
      "etc/certs/mail-outro-com.key",
      "etc/certs/mail-exemplo-com.crt",
      "etc/certs/mail-exemplo-com.key",
    ]);
    expect(files.find((f) => f.name === "etc/certs/")!.mode).toBe(0o700);
    expect(files.find((f) => f.name === "etc/certs/mail-exemplo-com.key")).toMatchObject({ content: "CHAVE-PEM", mode: 0o600 });
    expect(files.find((f) => f.name === "etc/certs/mail-exemplo-com.crt")).toMatchObject({ content: "CERT-PEM", mode: 0o600 });
    expect(String(files[1]!.content)).toContain("[certificate.mail-exemplo-com]");
    // o espelho local nunca guarda chave privada
    expect(await readFile(path.join(dir, "stalwart", "config.toml"), "utf8")).not.toContain("CHAVE-PEM");
  });

  it("container existente sem o alias novo: reconecta à rede com todos os aliases", async () => {
    const networks = JSON.stringify({ "paas-net": { Aliases: ["paas-stalwart", "abc123"] } });
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(networks) : undefined));
    await tlsManager().start();
    expect(calls).toContainEqual(["network", "disconnect", "paas-net", "paas-stalwart"]);
    expect(calls).toContainEqual([
      "network", "connect",
      "--alias", "paas-stalwart", "--alias", "mail.exemplo.com", "--alias", "mail.outro.com",
      "paas-net", "paas-stalwart",
    ]);
  });

  it("container existente já com os aliases: não mexe na rede", async () => {
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(ALL_ALIASES) : undefined));
    await tlsManager().start();
    expect(calls.some((a) => a[0] === "network" && (a[1] === "connect" || a[1] === "disconnect"))).toBe(false);
  });

  it("container fora da rede: conecta sem desconectar; falha ao conectar é erro claro", async () => {
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok("{}") : undefined));
    await tlsManager().start();
    expect(calls.some((a) => a[1] === "disconnect")).toBe(false);
    expect(calls.some((a) => a[1] === "connect")).toBe(true);

    responder = daemon({ running: true, mounts: NEW }, (a) =>
      isNetworksInspect(a) ? ok("não é json") : a[1] === "connect" ? fail("negado") : undefined,
    );
    await expect(tlsManager().start()).rejects.toThrow(/falha ao conectar paas-stalwart à rede paas-net com os aliases: negado/);
  });

  it("applyTls com troca de certificado: entrega os arquivos e recarrega pela API, sem reiniciar", async () => {
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(ALL_ALIASES) : undefined));
    const fetchMock = vi.fn(async () => new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await tlsManager({ apiBaseUrl: "http://paas-stalwart:8080" }).applyTls({ restart: false });
      expect(result).toBe("reloaded");
      expect(copies).toHaveLength(1);
      expect(calls.some((a) => a[0] === "restart")).toBe(false);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://paas-stalwart:8080/api/reload/certificate");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("admin:s3gredo").toString("base64")}`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("applyTls: API de recarga falha → reinicia o container (o certificado novo precisa valer)", async () => {
    responder = daemon({ running: true, mounts: NEW });
    try {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }));
      expect(await manager().applyTls({ restart: false })).toBe("restarted");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
      expect(await manager().applyTls({ restart: false })).toBe("restarted");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls.filter((a) => a[0] === "restart")).toEqual([["restart", "paas-stalwart"], ["restart", "paas-stalwart"]]);
  });

  it("applyTls com seção nova (primeiro certificado, hostname mudou): reinicia — o reload do Stalwart não relê o config.toml", async () => {
    responder = daemon({ running: true, mounts: NEW });
    expect(await manager().applyTls({ restart: true })).toBe("restarted");
    expect(ordem()).toEqual(["<cp>", "restart"]);

    responder = daemon({ running: true, mounts: NEW }, (a) => (a[0] === "restart" ? fail("sem container") : undefined));
    await expect(manager().applyTls({ restart: true })).rejects.toThrow(/falha ao reiniciar paas-stalwart: sem container/);
  });

  it("connectContainer: liga o painel à rede do Stalwart (idempotente)", async () => {
    responder = daemon(null, (a) => (a[0] === "inspect" ? ok(JSON.stringify({ "paas-net": {} })) : undefined));
    await manager().connectContainer("tws-panel");
    expect(calls.some((a) => a[1] === "connect")).toBe(false);

    responder = daemon(null, (a) => (a[0] === "inspect" ? ok("{}") : undefined));
    await manager().connectContainer("tws-panel");
    expect(calls).toContainEqual(["network", "connect", "paas-net", "tws-panel"]);

    responder = daemon(null, (a) => (a[0] === "inspect" ? fail("x") : a[1] === "connect" ? fail("negado") : undefined));
    await expect(manager().connectContainer("tws-panel")).rejects.toThrow(/falha ao conectar tws-panel à rede paas-net: negado/);
  });
});
