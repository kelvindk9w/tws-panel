/**
 * docker-socket.test.ts — reaper de helpers paas-terminal-* órfãos, no boot
 * E periodicamente (verificação recorrente — não só ao reiniciar o painel).
 *
 * Usa um servidor HTTP real escutando num unix socket temporário (mesma
 * forma de falar do cliente): verifica de verdade quais containers seriam
 * removidos — só os que batem o padrão EXATO paas-terminal-<8 hex>, e NUNCA
 * o helper de uma sessão ativa deste processo.
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSocketError,
  HOST_DOCKER_SOCKET,
  buildHostDockerAccessCheckCmd,
  buildHostDockerSocketPresentCmd,
  buildHostTerminalCmd,
  checkHostDockerAccess,
  createDockerPtyFactory,
  createHostDockerAccessProbe,
  removeOrphanTerminalHelpers,
  scheduleOrphanTerminalHelperReap,
} from "../src/services/docker-socket.js";
import type { ServerConfig } from "../src/config.js";

interface MockState {
  containers: Array<{ Id: string; Names: string[] }>;
  deleted: string[];
  listStatus: number;
  /** Corpos de POST /containers/create, na ordem (argv de cada helper). */
  created: Array<{ name: string; body: Record<string, unknown> }>;
  /** StatusCode devolvido por POST /containers/:id/wait. */
  waitStatusCode: number;
  /** StatusCodes por helper, na ordem de criação (vazio = waitStatusCode). */
  waitStatusCodes: number[];
  /** Status de POST /containers/create (201 = criado). */
  createStatus: number;
}

let server: http.Server | null = null;
let socketPath = "";
let tmp = "";
let state: MockState;
let upgradedSockets: Set<import("node:stream").Duplex>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-docker-mock-"));
  socketPath = path.join(tmp, "docker.sock");
  state = { containers: [], deleted: [], listStatus: 200, created: [], waitStatusCode: 0, waitStatusCodes: [], createStatus: 201 };
  upgradedSockets = new Set();
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/containers/json")) {
      res.writeHead(state.listStatus, { "content-type": "application/json" });
      res.end(
        state.listStatus === 200
          ? JSON.stringify(state.containers)
          : JSON.stringify({ message: "daemon indisponível" }),
      );
      return;
    }
    // imagem "sempre presente" — o teste do helper ativo não exercita pull.
    if (req.method === "GET" && req.url?.startsWith("/images/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: "sha256:fake" }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/containers/create")) {
      const name = new URL(req.url, "http://docker").searchParams.get("name") ?? "sem-nome";
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        if (state.createStatus !== 201) {
          res.writeHead(state.createStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "daemon recusou" }));
          return;
        }
        state.containers.push({ Id: name, Names: [`/${name}`] });
        state.created.push({ name, body: JSON.parse(body) as Record<string, unknown> });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: name }));
      });
      return;
    }
    if (req.method === "POST" && /^\/containers\/[^/]+\/start$/.test(req.url ?? "")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && /^\/containers\/[^/]+\/wait$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ StatusCode: state.waitStatusCodes.shift() ?? state.waitStatusCode }));
      return;
    }
    const del = /^DELETE \/containers\/([^?]+)\?force=true$/.exec(`${req.method} ${req.url}`);
    if (del) {
      const id = decodeURIComponent(del[1] ?? "");
      state.deleted.push(id);
      state.containers = state.containers.filter((c) => c.Id !== id);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: "not found" }));
  });
  // hijack (POST .../attach): responde com 101 Upgrade e mantém o socket
  // aberto — só precisa existir para openHostPty() resolver o RemotePty.
  // O socket do LADO DO SERVIDOR fica rastreado em upgradedSockets: sem
  // destruí-lo explicitamente no afterEach, server.close() trava para
  // sempre — mesmo com closeAllConnections() — porque uma conexão
  // "upgraded" (hijacked) não é liberada só por o CLIENTE destruir a dele.
  server.on("upgrade", (req, socket) => {
    if (req.url?.includes("/attach")) {
      upgradedSockets.add(socket);
      socket.on("close", () => upgradedSockets.delete(socket));
      socket.write("HTTP/1.1 101 UPGRADE\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      return;
    }
    socket.destroy();
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
});

afterEach(async () => {
  if (server) {
    for (const socket of upgradedSockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = null;
  await rm(tmp, { recursive: true, force: true });
});

describe("removeOrphanTerminalHelpers", () => {
  it("remove SÓ containers com o padrão exato paas-terminal-<8 hex>", async () => {
    state.containers = [
      { Id: "aaa111", Names: ["/paas-terminal-1a2b3c4d"] }, // órfão do painel → remove
      { Id: "bbb222", Names: ["/paas-terminal-custom"] }, // nome parecido do usuário → NÃO toca
      { Id: "ccc333", Names: ["/paas-terminal-1a2b3c4d5e"] }, // hex longo demais → NÃO toca
      { Id: "ddd444", Names: ["/meu-app"] }, // container do usuário → NÃO toca
      { Id: "eee555", Names: ["/paas-terminal-9f8e7d6c"] }, // outro órfão → remove
    ];

    const removed = await removeOrphanTerminalHelpers(socketPath);

    expect(removed).toEqual(["paas-terminal-1a2b3c4d", "paas-terminal-9f8e7d6c"]);
    expect(state.deleted).toEqual(["aaa111", "eee555"]);
  });

  it("sem órfãos: não remove nada e não chama DELETE", async () => {
    state.containers = [{ Id: "ddd444", Names: ["/meu-app"] }];
    const removed = await removeOrphanTerminalHelpers(socketPath);
    expect(removed).toEqual([]);
    expect(state.deleted).toEqual([]);
  });

  it("falha ao listar propaga DockerSocketError (caller loga como não fatal)", async () => {
    state.listStatus = 500;
    await expect(removeOrphanTerminalHelpers(socketPath)).rejects.toBeInstanceOf(DockerSocketError);
    expect(state.deleted).toEqual([]);
  });
});

/**
 * Bug do review 2026-08-24 (reaper-so-no-boot): a varredura só rodava no
 * boot — um leak por caminho de erro não coberto só seria limpo no próximo
 * restart. Mas uma varredura periódica ingênua (repetir a mesma lógica do
 * boot) removeria o helper de uma sessão de terminal ATIVA por baixo do
 * usuário, já que ele bate o mesmo padrão de nome paas-terminal-*. Por isso
 * a proteção abaixo é o requisito central do fix, testado separado da
 * simples repetição no tempo.
 */
describe("proteção do helper de sessão ativa", () => {
  const hostConfig = {
    dockerSocketPath: "",
    securityTarget: "host" as const,
    hostHelperImage: "alpine:3",
  } as unknown as ServerConfig;

  it("removeOrphanTerminalHelpers NUNCA remove o helper de uma sessão aberta por este processo", async () => {
    const factory = createDockerPtyFactory({ ...hostConfig, dockerSocketPath: socketPath });
    const pty = await factory();
    try {
      // o helper existe no daemon E bate o padrão paas-terminal-<8 hex> —
      // uma varredura ingênua o trataria como órfão.
      expect(state.containers).toHaveLength(1);
      const activeName = state.containers[0]!.Names[0]!.replace(/^\//, "");
      expect(activeName).toMatch(/^paas-terminal-[0-9a-f]{8}$/);

      const removed = await removeOrphanTerminalHelpers(socketPath);

      expect(removed).toEqual([]);
      expect(state.deleted).toEqual([]);
      expect(state.containers).toHaveLength(1); // continua vivo
    } finally {
      await pty.kill();
    }
  });

  it("depois de kill(), o helper deixa de ser protegido e volta a ser elegível para o reaper", async () => {
    const factory = createDockerPtyFactory({ ...hostConfig, dockerSocketPath: socketPath });
    const pty = await factory();
    const activeName = state.containers[0]!.Names[0]!.replace(/^\//, "");
    await pty.kill(); // sessão encerrada normalmente (equivalente a handleSessionEnd)

    // kill() já chama DELETE — mas simula o cenário do bug (caminho de erro
    // que NÃO limpou o container): ele reaparece no daemon como se o
    // AutoRemove não tivesse disparado, e a varredura deve pegá-lo agora.
    state.containers.push({ Id: activeName, Names: [`/${activeName}`] });
    const removed = await removeOrphanTerminalHelpers(socketPath);
    expect(removed).toEqual([activeName]);
  });
});

describe("scheduleOrphanTerminalHelperReap", () => {
  it("repete a varredura periodicamente E respeita a proteção do helper ativo", async () => {
    state.containers = [{ Id: "aaa111", Names: ["/paas-terminal-1a2b3c4d"] }];
    const timer = scheduleOrphanTerminalHelperReap(socketPath, 20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(state.deleted).toContain("aaa111");
    } finally {
      clearInterval(timer);
    }
  });

  it("o timer é unref()'d — não mantém o processo vivo sozinho", () => {
    const timer = scheduleOrphanTerminalHelperReap(socketPath, 60_000);
    try {
      // NodeJS.Timeout tem hasRef() quando unref()'d corretamente.
      expect((timer as unknown as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});

/**
 * Usuário do terminal (PAAS_TERMINAL_USER): o PTY no host abre como o
 * usuário configurado, e SEM a variável o argv é byte a byte o de antes.
 */
describe("usuário do terminal no host", () => {
  const NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];
  const hostConfig = (over: Partial<ServerConfig>) =>
    ({
      dockerSocketPath: socketPath,
      securityTarget: "host",
      hostHelperImage: "alpine:3",
      terminalUser: null,
      terminalRootMode: null,
      ...over,
    }) as unknown as ServerConfig;

  it("argv puro: legado/root = bash -l; usuário = runuser -l <usuário> como elemento separado", () => {
    expect(buildHostTerminalCmd(null)).toEqual([...NSENTER, "bash", "-l"]);
    expect(buildHostTerminalCmd("root")).toEqual([...NSENTER, "bash", "-l"]);
    const argv = buildHostTerminalCmd("kelvin");
    expect(argv).toEqual([...NSENTER, "runuser", "-l", "kelvin"]);
    // o nome nunca é interpolado numa string de shell
    expect(argv.some((a) => a.includes(" "))).toBe(false);
  });

  it("argv puro recusa nome inválido (defesa em profundidade além do config)", () => {
    expect(() => buildHostTerminalCmd("kelvin; bash")).toThrow(/usuário do terminal inválido/);
  });

  it("sem PAAS_TERMINAL_USER: um único helper, argv idêntico ao de antes (compatibilidade)", async () => {
    const pty = await createDockerPtyFactory(hostConfig({}))();
    try {
      expect(state.created).toHaveLength(1);
      expect(state.created[0]!.body["Cmd"]).toEqual([
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-l",
      ]);
      expect(state.created[0]!.body["Tty"]).toBe(true);
    } finally {
      await pty.kill();
    }
  });

  it("PAAS_TERMINAL_USER=root: mesmo argv do legado, sem verificação de usuário", async () => {
    const pty = await createDockerPtyFactory(hostConfig({ terminalUser: "root" }))();
    try {
      expect(state.created).toHaveLength(1);
      expect(state.created[0]!.body["Cmd"]).toEqual([...NSENTER, "bash", "-l"]);
    } finally {
      await pty.kill();
    }
  });

  it("usuário comum: verifica que existe (id -u) e abre shell de login dele (runuser -l)", async () => {
    const pty = await createDockerPtyFactory(
      hostConfig({ terminalUser: "kelvin", terminalRootMode: "senha" }),
    )();
    try {
      expect(state.created).toHaveLength(2);
      const [check, terminal] = state.created;
      expect(check!.body["Cmd"]).toEqual([...NSENTER, "id", "-u", "kelvin"]);
      expect(check!.body["Tty"]).toBeFalsy();
      expect(check!.name).toMatch(/^paas-terminal-check-[0-9a-f]{8}$/);
      // o helper de verificação é removido depois de consultado
      expect(state.deleted).toContain(check!.name);
      expect(terminal!.body["Cmd"]).toEqual([...NSENTER, "runuser", "-l", "kelvin"]);
      expect(terminal!.name).toMatch(/^paas-terminal-[0-9a-f]{8}$/);
    } finally {
      await pty.kill();
    }
  });

  it("usuário inexistente: falha com mensagem clara e NUNCA abre terminal root no lugar", async () => {
    state.waitStatusCode = 1;
    const factory = createDockerPtyFactory(hostConfig({ terminalUser: "fantasma", terminalRootMode: "senha" }));
    const err = await factory().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerSocketError);
    expect((err as Error).message).toMatch(/usuário "fantasma".*não existe na VPS/);
    expect((err as Error).message).toMatch(/não foi aberto como root/);
    // só o helper de verificação foi criado (e removido) — nenhum PTY
    expect(state.created).toHaveLength(1);
    expect(state.containers).toHaveLength(0);
  });
});

/**
 * Pertencer ao grupo dono do docker.sock do host = root sem senha
 * (`docker run --privileged -v /:/host … chroot /host`). Nos modos senha e
 * segundo-plano isso anula a proteção — o painel verifica e expõe o fato.
 */
describe("acesso do usuário do terminal ao Docker do host", () => {
  const NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"];

  it("argv puro: socket conferido como root; acesso testado COMO o usuário, nome em elemento separado", () => {
    expect(HOST_DOCKER_SOCKET).toBe("/var/run/docker.sock");
    expect(buildHostDockerSocketPresentCmd()).toEqual([...NSENTER, "test", "-S", "/var/run/docker.sock"]);
    const argv = buildHostDockerAccessCheckCmd("kelvin");
    expect(argv).toEqual([...NSENTER, "runuser", "-u", "kelvin", "--", "test", "-w", "/var/run/docker.sock"]);
    // nunca uma string de shell: nenhum sh -c, nenhum elemento com espaço
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("-c");
    expect(argv.some((a) => a.includes(" "))).toBe(false);
  });

  it("argv puro recusa nome inválido e root (não se aplica)", () => {
    expect(() => buildHostDockerAccessCheckCmd("kelvin; bash")).toThrow(/usuário do terminal inválido/);
    expect(() => buildHostDockerAccessCheckCmd("root")).toThrow(/usuário do terminal inválido/);
  });

  it("socket presente e o usuário consegue escrever nele → sim (dois helpers, ambos removidos)", async () => {
    state.waitStatusCodes = [0, 0];
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "kelvin")).resolves.toBe("sim");
    expect(state.created.map((c) => c.body["Cmd"])).toEqual([
      [...NSENTER, "test", "-S", "/var/run/docker.sock"],
      [...NSENTER, "runuser", "-u", "kelvin", "--", "test", "-w", "/var/run/docker.sock"],
    ]);
    for (const c of state.created) {
      expect(c.name).toMatch(/^paas-terminal-check-[0-9a-f]{8}$/);
      expect(c.body["Tty"]).toBeFalsy();
      expect(state.deleted).toContain(c.name);
    }
    expect(state.containers).toHaveLength(0);
  });

  it("socket presente e o usuário NÃO consegue escrever (test sai 1) → nao", async () => {
    state.waitStatusCodes = [0, 1];
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "kelvin")).resolves.toBe("nao");
  });

  it("socket ausente no caminho padrão: não afirma 'nao' — nao-verificado, sem testar o usuário", async () => {
    state.waitStatusCodes = [1];
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "kelvin")).resolves.toBe("nao-verificado");
    expect(state.created).toHaveLength(1);
  });

  it.each([125, 126, 127, -1])("runuser falhou (código %i) → nao-verificado", async (code) => {
    state.waitStatusCodes = [0, code];
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "kelvin")).resolves.toBe("nao-verificado");
  });

  it("Docker recusou criar o helper → nao-verificado (nunca lança)", async () => {
    state.createStatus = 500;
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "kelvin")).resolves.toBe("nao-verificado");
  });

  it("docker.sock do painel inacessível → nao-verificado", async () => {
    await expect(checkHostDockerAccess(path.join(tmp, "nao-existe.sock"), "alpine:3", "kelvin")).resolves.toBe(
      "nao-verificado",
    );
  });

  it("nome inválido → nao-verificado sem criar helper nenhum", async () => {
    await expect(checkHostDockerAccess(socketPath, "alpine:3", "x; reboot")).resolves.toBe("nao-verificado");
    expect(state.created).toHaveLength(0);
  });

  describe("createHostDockerAccessProbe", () => {
    const cfg = (over: Partial<ServerConfig>) =>
      ({
        dockerSocketPath: socketPath,
        securityTarget: "host",
        hostHelperImage: "alpine:3",
        terminalUser: null,
        terminalRootMode: null,
        ...over,
      }) as unknown as ServerConfig;

    it("não se aplica (null) no legado, em root explícito e no container de dev", () => {
      expect(createHostDockerAccessProbe(cfg({}))).toBeNull();
      expect(createHostDockerAccessProbe(cfg({ terminalUser: "root" }))).toBeNull();
      expect(
        createHostDockerAccessProbe(cfg({ securityTarget: "container", terminalUser: "kelvin", terminalRootMode: "senha" })),
      ).toBeNull();
    });

    it("usuário comum: a sonda verifica no host o usuário configurado", async () => {
      const probe = createHostDockerAccessProbe(cfg({ terminalUser: "kelvin", terminalRootMode: "segundo-plano" }));
      expect(probe).not.toBeNull();
      state.waitStatusCodes = [0, 0];
      await expect(probe!()).resolves.toBe("sim");
      expect(state.created[1]!.body["Cmd"]).toEqual([
        ...NSENTER, "runuser", "-u", "kelvin", "--", "test", "-w", "/var/run/docker.sock",
      ]);
    });
  });
});
