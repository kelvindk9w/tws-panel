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
    // redes do container: já nas duas, só com o alias do nome (sem mail.<domínio>)
    if (args[0] === "inspect" && (args[2] ?? "").includes("Networks")) {
      return state ? ok(JSON.stringify({ "paas-mail-admin": { Aliases: ["paas-stalwart"] }, "paas-mail": { Aliases: ["paas-stalwart"] } })) : fail("No such object");
    }
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

    expect(ordem()).toEqual(["network", "network", "inspect", "create", "network", "<cp>", "start"]);
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
    expect(calls[1]).toEqual(["network", "create", "--label", "paas.managed=true", "paas-mail-admin"]);
    expect(calls[3]).toEqual(["network", "create", "--label", "paas.managed=true", "paas-mail"]);

    responder = daemon(null, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : a[0] === "network" ? fail("negado") : undefined));
    await expect(manager().start()).rejects.toThrow(/falha ao criar a rede paas-mail-admin: negado/);
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
    expect(ordem()).toEqual(["network", "network", "inspect", "<cp>", "inspect", "start"]);
  });

  it("rodando com montagem nova: regrava a config e não recria", async () => {
    responder = daemon({ running: true, mounts: NEW });
    await manager().start();
    expect(ordem()).toEqual(["network", "network", "inspect", "<cp>", "inspect"]);
  });

  it("start responde 'already in use': considera no ar", async () => {
    responder = daemon({ running: false, mounts: NEW }, (a) => (a[0] === "start" ? fail("container already in use") : undefined));
    await manager().start();
    expect(ordem()).toEqual(["network", "network", "inspect", "<cp>", "inspect", "start"]);
  });

  it("start falha por outro motivo: remove (com o volume anônimo) e recria", async () => {
    let starts = 0;
    responder = daemon({ running: false, mounts: NEW }, (a) => (a[0] === "start" && starts++ === 0 ? fail("imagem antiga") : undefined));
    await manager().start();
    expect(ordem()).toEqual(["network", "network", "inspect", "<cp>", "inspect", "start", "rm", "create", "network", "<cp>", "start"]);
    expect(calls.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", "paas-stalwart"]);
  });

  it.each([
    ["parado (produção: etc vazio no host)", false],
    ["rodando (desenvolvimento)", true],
  ])("montagem ANTIGA %s: remove e recria com a config entregue pelo daemon", async (_n, running) => {
    responder = daemon({ running, mounts: LEGACY });
    await manager().start();
    expect(ordem()).toEqual(["network", "network", "inspect", "rm", "create", "network", "<cp>", "start"]);
    expect(calls.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", "paas-stalwart"]);
  });
});

// ---------------------------------------------------------------------------
// Certificado de verdade e alias mail.<domínio> (validação real, 01/10/2026:
// o app do projeto recusava o autoassinado e o nome paas-stalwart).
// ---------------------------------------------------------------------------

const CERT = { host: "mail.exemplo.com", cert: "CERT-PEM", key: "CHAVE-PEM" };
const CERT2 = { host: "mail.outro.com", cert: "CERT2-PEM", key: "CHAVE2-PEM" };
const TODOS = ["paas-stalwart", "mail.exemplo.com", "mail.outro.com"];
const ALL_ALIASES = JSON.stringify({ "paas-mail-admin": { Aliases: TODOS }, "paas-mail": { Aliases: TODOS } });
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

  // Achado 7 da revisão: mail.foo-bar.com e mail.foo.bar.com davam o mesmo
  // id (mail-foo-bar-com) — seção [certificate.*] repetida e arquivos sobrescritos.
  it("hosts que só diferem na posição de ponto e hífen ganham seções e arquivos diferentes", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.foo.bar.com", "s", ["mail.foo-bar.com", "mail.foo.bar.com"]);
    const sections = toml.match(/^\[certificate\.[^\]]+\]$/gm) ?? [];
    expect(sections).toHaveLength(2);
    expect(new Set(sections).size).toBe(2);
    expect(toml).toContain("[certificate.mail-foo--bar-com]");
    expect(toml).toContain("/opt/stalwart-mail/etc/certs/mail-foo--bar-com.crt");
  });

  it("hostname do servidor sem certificado: o primeiro vira o padrão", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.localhost", "s", ["mail.outro.com"]);
    expect(toml).toMatch(/\[certificate\.mail-outro-com\][^[]*default = true/);
  });
});

describe("renderConfigToml — entregabilidade (chaves conferidas no Stalwart v0.11.8)", () => {
  it("acrescenta Message-ID e Date que faltem também na submissão (465/587), não só na porta 25", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.exemplo.com", "s");
    expect(toml).toMatch(/^session\.data\.add-headers\.message-id = true$/m);
    expect(toml).toMatch(/^session\.data\.add-headers\.date = true$/m);
  });

  it("sai só por IPv4 (o SPF só tem ip4 e não há PTR IPv6)", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    expect(renderConfigToml("mail.exemplo.com", "s")).toMatch(/^queue\.outbound\.ip-strategy = "ipv4_only"$/m);
  });

  it("report.domain = domínio de e-mail cadastrado; sem ele, a chave não aparece (vale o padrão do Stalwart)", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.envio.exemplo.com.br", "s", [], { reportDomain: "envio.exemplo.com.br" });
    expect(toml).toMatch(/^report\.domain = "envio\.exemplo\.com\.br"$/m);
    expect(renderConfigToml("mail.localhost", "s")).not.toContain("report.domain");
  });

  it("as chaves soltas ficam antes da primeira seção [..] (senão o TOML as põe dentro dela)", async () => {
    const { renderConfigToml } = await import("../src/server.js");
    const toml = renderConfigToml("mail.exemplo.com", "s", [], { reportDomain: "exemplo.com" });
    const firstSection = toml.indexOf("\n[");
    for (const key of ["session.data.add-headers.message-id", "queue.outbound.ip-strategy", "report.domain"]) {
      expect(toml.indexOf(key)).toBeGreaterThan(-1);
      expect(toml.indexOf(key)).toBeLessThan(firstSection);
    }
  });

  it("configFingerprint muda quando a configuração muda e não carrega o segredo", async () => {
    const { stalwartConfigFingerprint } = await import("../src/server.js");
    const base = stalwartConfigFingerprint({ hostname: "mail.a.com", certificateHosts: ["mail.a.com"], reportDomain: "a.com" });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(stalwartConfigFingerprint({ hostname: "mail.a.com", certificateHosts: ["mail.a.com"], reportDomain: "a.com" })).toBe(base);
    expect(stalwartConfigFingerprint({ hostname: "mail.a.com", certificateHosts: ["mail.a.com"], reportDomain: "b.com" })).not.toBe(base);
    expect(stalwartConfigFingerprint({ hostname: "mail.a.com", certificateHosts: [] })).not.toBe(base);
  });

  it("o manager entrega ao container o config com o report.domain recebido", async () => {
    responder = daemon(null);
    await manager({ reportDomain: "exemplo.com" }).start();
    const toml = copies[0]!.files.find((f) => f.name === "etc/config.toml")!.content as string;
    expect(toml).toContain('report.domain = "exemplo.com"');
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
    const networks = JSON.stringify({ "paas-mail-admin": { Aliases: ["paas-stalwart", "abc123"] }, "paas-mail": { Aliases: TODOS } });
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(networks) : undefined));
    await tlsManager().start();
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail-admin", "paas-stalwart"]);
    expect(calls).toContainEqual([
      "network", "connect",
      "--alias", "paas-stalwart", "--alias", "mail.exemplo.com", "--alias", "mail.outro.com",
      "paas-mail-admin", "paas-stalwart",
    ]);
    // a rede de e-mail já estava certa
    expect(calls.some((a) => a[1] === "disconnect" && a[2] === "paas-mail")).toBe(false);
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
    expect(calls.filter((a) => a[1] === "connect").map((a) => a[a.length - 2])).toEqual(["paas-mail-admin", "paas-mail"]);

    responder = daemon({ running: true, mounts: NEW }, (a) =>
      isNetworksInspect(a) ? ok("não é json") : a[1] === "connect" ? fail("negado") : undefined,
    );
    await expect(tlsManager().start()).rejects.toThrow(/falha ao conectar paas-stalwart à rede paas-mail-admin com os aliases: negado/);
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
    expect(ordem()).toEqual(["<cp>", "inspect", "restart"]);

    responder = daemon({ running: true, mounts: NEW }, (a) => (a[0] === "restart" ? fail("sem container") : undefined));
    await expect(manager().applyTls({ restart: true })).rejects.toThrow(/falha ao reiniciar paas-stalwart: sem container/);
  });

  it("connectContainer: liga o painel à rede do Stalwart (idempotente)", async () => {
    responder = daemon(null, (a) => (a[0] === "inspect" ? ok(JSON.stringify({ "paas-mail-admin": {} })) : undefined));
    await manager().connectContainer("tws-panel");
    expect(calls.some((a) => a[1] === "connect")).toBe(false);

    responder = daemon(null, (a) => (a[0] === "inspect" ? ok("{}") : undefined));
    await manager().connectContainer("tws-panel");
    expect(calls).toContainEqual(["network", "connect", "paas-mail-admin", "tws-panel"]);

    responder = daemon(null, (a) => (a[0] === "inspect" ? fail("x") : a[1] === "connect" ? fail("negado") : undefined));
    await expect(manager().connectContainer("tws-panel")).rejects.toThrow(/falha ao conectar tws-panel à rede paas-mail-admin: negado/);
  });
});

/**
 * A4: os projetos hospedados ficam só na paas-net. O Stalwart (e a administração
 * dele) fica em redes à parte: paas-mail-admin (só ele e o painel) e paas-mail
 * (SMTP/IMAP para o webmail e os projetos com e-mail habilitado).
 */
describe("StalwartManager — redes separadas da paas-net (A4)", () => {
  it("nasce na rede da administração e na de e-mail, nunca na paas-net", async () => {
    responder = daemon(null);
    await tlsManager().start();
    const create = calls.find((a) => a[0] === "create")!;
    expect(create[create.indexOf("--network") + 1]).toBe("paas-mail-admin");
    expect(calls).toContainEqual([
      "network", "connect",
      "--alias", "paas-stalwart", "--alias", "mail.exemplo.com", "--alias", "mail.outro.com",
      "paas-mail", "paas-stalwart",
    ]);
    expect(JSON.stringify(calls)).not.toContain('"paas-net"');
  });

  it("instalação antiga (só na paas-net): entra nas duas redes novas, mas só sai da paas-net quando mandarem", async () => {
    const antigo = JSON.stringify({ "paas-net": { Aliases: TODOS } });
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(antigo) : undefined));
    const m = tlsManager();
    await m.start();
    const entrou = calls.filter((a) => a[1] === "connect").map((a) => a[a.length - 2]);
    expect(entrou).toEqual(["paas-mail-admin", "paas-mail"]);
    expect(calls.some((a) => a[1] === "disconnect")).toBe(false);

    calls.length = 0;
    await m.leaveProjectNetwork();
    expect(calls).toContainEqual(["network", "disconnect", "paas-net", "paas-stalwart"]);
  });

  it("leaveProjectNetwork: já fora da paas-net não faz nada; 'not connected' é tolerado; outra falha é erro", async () => {
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(ALL_ALIASES) : undefined));
    await manager().leaveProjectNetwork();
    expect(calls.some((a) => a[1] === "disconnect")).toBe(false);

    const comNet = JSON.stringify({ "paas-net": {}, "paas-mail": {} });
    responder = daemon({ running: true, mounts: NEW }, (a) =>
      isNetworksInspect(a) ? ok(comNet) : a[1] === "disconnect" ? fail("container is not connected to network paas-net") : undefined,
    );
    await expect(manager().leaveProjectNetwork()).resolves.toBeUndefined();

    responder = daemon({ running: true, mounts: NEW }, (a) =>
      isNetworksInspect(a) ? ok(comNet) : a[1] === "disconnect" ? fail("busy") : undefined,
    );
    await expect(manager().leaveProjectNetwork()).rejects.toThrow(/falha ao tirar paas-stalwart da rede paas-net: busy/);

    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok("ilegível") : undefined));
    await expect(manager().leaveProjectNetwork()).resolves.toBeUndefined();
  });

  it("joinMailNetworks: container que não existe → não faz nada; existente → cria as redes e liga às duas", async () => {
    responder = daemon(null);
    await manager().joinMailNetworks();
    expect(ordem()).toEqual(["inspect"]);

    calls.length = 0;
    const antigo = JSON.stringify({ "paas-net": { Aliases: ["paas-stalwart"] } });
    responder = daemon({ running: true, mounts: NEW }, (a) => (isNetworksInspect(a) ? ok(antigo) : undefined));
    await manager().joinMailNetworks();
    expect(calls.filter((a) => a[1] === "connect").map((a) => a[a.length - 2])).toEqual(["paas-mail-admin", "paas-mail"]);
    expect(calls.some((a) => a[1] === "disconnect")).toBe(false);
  });
});
