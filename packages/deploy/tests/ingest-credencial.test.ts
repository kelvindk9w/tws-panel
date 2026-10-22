/**
 * Ingestão git de repositórios PRIVADOS com credencial de LEITURA.
 *
 * O painel só pode LER repositórios — nunca escrever, commitar ou dar push.
 * A credencial é um token de leitura (no GitHub, um fine-grained PAT com
 * `Contents: Read`) guardado cifrado pelo cofre do servidor e entregue à
 * ingestão por `ctx.credentialFor`.
 *
 * O que estes testes protegem, e por quê:
 *  - O token NUNCA pode ir para a linha de comando (`ps` do host mostra o
 *    argv de qualquer processo) nem para a URL do remote (fica em texto puro
 *    no .git/config do clone, para sempre). O caminho aceito é GIT_ASKPASS +
 *    variável de ambiente.
 *  - O log do deploy é transmitido ao operador e persistido: o valor não pode
 *    aparecer nele em hipótese alguma, nem via mensagem de erro do git.
 *
 * O repositório "privado" do teste é servido por HTTP com Basic auth (git
 * dumb HTTP sobre um bare repo com update-server-info) — é a forma mais
 * próxima do real sem depender de rede externa.
 */
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCredential, Project } from "@paas/core";
import { ingestCode } from "../src/ingest.js";

/**
 * Espiona TODOS os argv montados pela ingestão. O passthrough é intencional:
 * os comandos git rodam de verdade, o mock só registra o que foi executado.
 */
const chamadas: { file: string; args: string[] }[] = [];
vi.mock("../src/exec.js", async () => {
  const real = await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
  return {
    ...real,
    run: (file: string, args: string[], opts?: unknown) => {
      chamadas.push({ file, args });
      return real.run(file, args, opts as never);
    },
  };
});

const TOKEN = "ghp_TOKENDELEITURAsupersecreto0001";

let tmp: string;
let projectsDir: string;
let bare: string;
let server: http.Server;
let urlPrivada: string;
let repoPublico: string;
/** Requisições que chegaram ao servidor com credencial válida. */
let autenticadas = 0;
/** Requisições que chegaram ao endereço FINAL de um redirecionamento. */
let destinoDoRedirect = 0;
let outro: http.Server;
let urlOutro: string;
/** Pedidos que chegaram ao OUTRO host, com o cabeçalho Authorization. */
let pedidosOutro: { url: string; auth: string }[] = [];

async function git(args: string[]): Promise<void> {
  const { run } = await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
  const r = await run("git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

/** Cria um repositório de trabalho com um commit na main. */
async function criarRepo(dir: string): Promise<void> {
  await git(["init", "-q", "-b", "main", dir]);
  await git(["-C", dir, "config", "user.email", "teste@exemplo.com"]);
  await git(["-C", dir, "config", "user.name", "Teste"]);
  await writeFile(path.join(dir, "arquivo.txt"), "conteudo\n");
  await git(["-C", dir, "add", "."]);
  await git(["-C", dir, "commit", "-q", "-m", "commit inicial"]);
}

function projeto(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "App",
    slug: "app",
    ingestMode: "git",
    source: urlPrivada,
    branch: "main",
    domain: "app.localhost",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...overrides,
  };
}

function comCredencial(cred: GitReadCredential | null) {
  return {
    projectsDir,
    credentialFor: async () => cred,
  };
}

beforeEach(async () => {
  chamadas.length = 0;
  autenticadas = 0;
  destinoDoRedirect = 0;
  pedidosOutro = [];
  tmp = await mkdtemp(path.join(tmpdir(), "paas-cred-test-"));
  projectsDir = path.join(tmp, "projects");
  repoPublico = path.join(tmp, "publico");
  await criarRepo(repoPublico);

  const work = path.join(tmp, "origem");
  await criarRepo(work);
  bare = path.join(tmp, "privado.git");
  await git(["clone", "-q", "--bare", work, bare]);
  await git(["-C", bare, "update-server-info"]);

  outro = http.createServer((req, res) => {
    pedidosOutro.push({ url: req.url ?? "", auth: req.headers.authorization ?? "" });
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    res.end("x");
  });
  await new Promise<void>((resolve) => outro.listen(0, "127.0.0.1", resolve));
  urlOutro = `http://127.0.0.1:${(outro.address() as { port: number }).port}`;

  server = http.createServer((req, res) => {
    const caminho = new URL(req.url ?? "/", "http://x").pathname;
    // privado movido no MESMO host (GitLab sem .git): redireciona e continua exigindo o token
    if (caminho.startsWith("/movido-privado.git/")) {
      res.writeHead(301, { Location: `http://${req.headers.host}${req.url?.replace("/movido-privado.git/", "/privado.git/")}` });
      return res.end();
    }
    // saindo para OUTRO host: o token não pode chegar lá
    if (caminho.startsWith("/saindo.git/")) {
      res.writeHead(302, { Location: `${urlOutro}${req.url?.replace("/saindo.git/", "/privado.git/")}` });
      return res.end();
    }
    // repositório "movido": 301 para o endereço final (como o GitLab sem o .git), que é público
    if (caminho.startsWith("/movido.git/")) {
      res.writeHead(301, { Location: `http://${req.headers.host}${req.url?.replace("/movido.git/", "/final.git/")}` });
      return res.end();
    }
    if (caminho.startsWith("/final.git/")) {
      destinoDoRedirect += 1;
      const alvo = path.join(bare, caminho.replace("/final.git/", ""));
      void stat(alvo)
        .then(() => {
          res.writeHead(200);
          createReadStream(alvo).pipe(res);
        })
        .catch(() => {
          res.writeHead(404);
          res.end("nao encontrado");
        });
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Basic ")) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      return res.end("autenticacao necessaria");
    }
    const senha = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":")[1];
    if (senha !== TOKEN) {
      res.writeHead(403);
      return res.end("credencial recusada");
    }
    autenticadas += 1;
    const rel = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/privado\.git\//, "");
    const alvo = path.join(bare, rel);
    void stat(alvo)
      .then((st) => {
        if (!st.isFile()) throw new Error("nao e arquivo");
        res.writeHead(200);
        createReadStream(alvo).pipe(res);
      })
      .catch(() => {
        res.writeHead(404);
        res.end("nao encontrado");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const porta = typeof addr === "object" && addr ? addr.port : 0;
  urlPrivada = `http://127.0.0.1:${porta}/privado.git`;
});

afterEach(async () => {
  outro.closeAllConnections();
  await new Promise<void>((resolve) => outro.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

describe("ingestCode — repositório privado com credencial de leitura", () => {
  it("clona o repositório privado usando a credencial do cofre", async () => {
    const src = await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto(),
      () => {},
    );
    await expect(stat(path.join(src, "arquivo.txt"))).resolves.toBeTruthy();
    expect(autenticadas).toBeGreaterThan(0);
  }, 30_000);

  it("o token não aparece em NENHUM argumento de processo (não vaza no ps do host)", async () => {
    await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto(),
      () => {},
    );
    const todosOsArgs = chamadas.flatMap((c) => [c.file, ...c.args]);
    expect(todosOsArgs.length).toBeGreaterThan(0);
    for (const arg of todosOsArgs) {
      expect(arg).not.toContain(TOKEN);
    }
  }, 30_000);

  it("repositório público que redireciona (301) continua clonando SEM token, como antes", async () => {
    const src = await ingestCode(comCredencial(null), projeto({ source: urlPrivada.replace("/privado.git", "/movido.git") }), () => {});
    await expect(stat(path.join(src, "arquivo.txt"))).resolves.toBeTruthy();
    expect(destinoDoRedirect).toBeGreaterThan(0);
  }, 30_000);

  it("COM token, redirecionamento no MESMO host funciona (GitLab privado cadastrado sem .git)", async () => {
    const src = await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto({ source: urlPrivada.replace("/privado.git", "/movido-privado.git") }),
      () => {},
    );
    await expect(stat(path.join(src, "arquivo.txt"))).resolves.toBeTruthy();
    expect(autenticadas).toBeGreaterThan(0);
  }, 30_000);

  it("COM token, redirecionamento para OUTRO host: o token não é enviado e a mensagem diz o que fazer", async () => {
    const erro = await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto({ source: urlPrivada.replace("/privado.git", "/saindo.git") }),
      () => {},
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(erro).not.toBeNull();
    expect(erro?.message).toMatch(/endereço final/i);
    expect(erro?.message).toMatch(/outro (host|endereço)/i);
    expect(erro?.message).not.toContain(TOKEN);
    // o outro host foi procurado, mas nenhum pedido levou credencial
    expect(pedidosOutro.length).toBeGreaterThan(0);
    expect(pedidosOutro.every((p) => p.auth === "")).toBe(true);
    expect(JSON.stringify(pedidosOutro)).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
  }, 30_000);

  it("o token não é gravado no .git/config do clone (remote.origin.url limpa)", async () => {
    const src = await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto(),
      () => {},
    );
    const { run } = await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const origem = await run("git", ["-C", src, "remote", "get-url", "origin"]);
    expect(origem.stdout.trim()).toBe(urlPrivada);
    expect(origem.stdout).not.toContain(TOKEN);
  }, 30_000);

  it("o token não aparece em nenhum pedaço do log emitido", async () => {
    const pedacos: string[] = [];
    await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto(),
      (c) => pedacos.push(c),
    );
    expect(pedacos.length).toBeGreaterThan(0);
    for (const pedaco of pedacos) expect(pedaco).not.toContain(TOKEN);
  }, 30_000);

  it("atualiza o clone existente (fetch/pull) também com a credencial", async () => {
    const ctx = comCredencial({ username: "x-access-token", token: TOKEN });
    await ingestCode(ctx, projeto(), () => {});
    autenticadas = 0;
    const pedacos: string[] = [];
    await ingestCode(ctx, projeto(), (c) => pedacos.push(c));
    expect(pedacos.join("")).toMatch(/atualizando clone existente/i);
    // fetch/pull também precisam autenticar — repositório privado não deixa
    // nem atualizar sem credencial.
    expect(autenticadas).toBeGreaterThan(0);
    for (const pedaco of pedacos) expect(pedaco).not.toContain(TOKEN);
  }, 60_000);

  /**
   * Validação real (30/09/2026, VPS): "cannot exec '/tmp/paas-git-cred-…/askpass.sh':
   * Permission denied". O container do painel monta /tmp sem permissão de
   * execução (hardening), então o script auxiliar do GIT_ASKPASS nunca rodava e
   * todo repositório privado falhava. O token agora chega ao git por um
   * credential helper em linha que só LÊ variáveis de ambiente: nenhum arquivo
   * é criado — nada a executar, nada a vazar no disco.
   */
  it("não cria arquivo auxiliar nenhum para entregar o token (o /tmp do container não executa)", async () => {
    const antes = new Set(await readdir(tmpdir()));
    await ingestCode(comCredencial({ username: "x-access-token", token: TOKEN }), projeto(), () => {});
    await expect(
      ingestCode(comCredencial({ username: "x-access-token", token: "errado" }), projeto({ slug: "outro" }), () => {}),
    ).rejects.toThrow();
    const novos = (await readdir(tmpdir())).filter((n) => !antes.has(n) && n.startsWith("paas-git-cred-"));
    expect(novos).toEqual([]);
    // o painel não faz mais `git clone` dentro de src (ver git-safe.ts): quem fala
    // com o servidor do repositório é o `git fetch`, e é ele que leva o helper.
    const fetch = chamadas.find((c) => c.args.includes("fetch"))!;
    expect(fetch.args.join(" ")).toContain("credential.helper=");
    expect(fetch.args.join(" ")).not.toContain(TOKEN);
  }, 60_000);
});

describe("ingestCode — sem credencial", () => {
  it("repositório público continua clonando exatamente como hoje", async () => {
    const src = await ingestCode(
      { projectsDir },
      projeto({ source: repoPublico }),
      () => {},
    );
    await expect(stat(path.join(src, "arquivo.txt"))).resolves.toBeTruthy();
  }, 30_000);

  it("repositório privado sem credencial → erro em pt-BR orientando cadastrar token de LEITURA", async () => {
    await expect(ingestCode({ projectsDir }, projeto(), () => {})).rejects.toThrow(
      /privado.*token de leitura|token de leitura/is,
    );
  }, 30_000);

  it("a orientação não é dada quando o erro não é de autenticação (branch inexistente)", async () => {
    const erro = await ingestCode({ projectsDir }, projeto({ source: repoPublico, branch: "nao-existe" }), () => {}).catch(
      (e: Error) => e,
    );
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).not.toMatch(/token de leitura/i);
  }, 30_000);

  it("credencial recusada pelo servidor → erro diz que a credencial foi recusada, sem vazar o valor", async () => {
    const erro = await ingestCode(
      comCredencial({ username: "x-access-token", token: "token-invalido-xyz" }),
      projeto(),
      () => {},
    ).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toMatch(/credencial/i);
    expect((erro as Error).message).not.toContain("token-invalido-xyz");
  }, 30_000);
});

describe("ingestCode — cadastro https que redireciona para http na mesma porta", () => {
  let dirTls: string;
  let mux: net.Server;
  let cainfoAntes: string | undefined;
  const sockets = new Set<net.Socket>();
  let internos: net.Server[] = [];
  /** Pedidos que chegaram ao lado http (sem criptografia). */
  let pedidosHttp: { auth: string }[] = [];

  beforeEach(async () => {
    pedidosHttp = [];
    dirTls = await mkdtemp(path.join(tmpdir(), "paas-tls-test-"));
    const chave = path.join(dirTls, "k.pem");
    const cert = path.join(dirTls, "c.pem");
    const { run } = await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
    const r = await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", chave, "-out", cert,
      "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    if (r.code !== 0) throw new Error(`openssl falhou: ${r.stderr}`);
    cainfoAntes = process.env.GIT_SSL_CAINFO;
    process.env.GIT_SSL_CAINFO = cert;

    const lado = (req: http.IncomingMessage, res: http.ServerResponse, cifrado: boolean) => {
      if (cifrado) {
        // cadastro em https: manda o git para o MESMO host e porta, mas em http puro
        res.writeHead(302, { Location: `http://${req.headers.host}${req.url}` });
        return res.end();
      }
      pedidosHttp.push({ auth: req.headers.authorization ?? "" });
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end("x");
    };
    const servidorHttp = http.createServer((q, s) => lado(q, s, false));
    const servidorHttps = https.createServer(
      { key: await readFile(chave), cert: await readFile(cert) },
      (q, s) => lado(q, s, true),
    );
    // mesma porta para os dois: o primeiro byte decide (0x16 = handshake TLS) e a conexão é repassada
    // a um servidor interno (o TLSSocket lê direto do handle, então não dá para devolver o byte lido)
    await new Promise<void>((resolve) => servidorHttp.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => servidorHttps.listen(0, "127.0.0.1", resolve));
    internos = [servidorHttp, servidorHttps];
    mux = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("data", (buf) => {
        const alvo = (buf[0] === 0x16 ? servidorHttps : servidorHttp).address() as net.AddressInfo;
        const ponte = net.connect(alvo.port, "127.0.0.1", () => {
          ponte.write(buf);
          socket.pipe(ponte);
          ponte.pipe(socket);
        });
        sockets.add(ponte);
        const fim = () => {
          socket.destroy();
          ponte.destroy();
        };
        socket.on("error", fim);
        ponte.on("error", fim);
        socket.on("close", fim);
        ponte.on("close", fim);
      });
    });
    await new Promise<void>((resolve) => mux.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    if (cainfoAntes === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = cainfoAntes;
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => mux.close(() => resolve()));
    for (const s of internos) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    await rm(dirTls, { recursive: true, force: true });
  });

  it("o lado http não recebe Authorization nem o token, e a mensagem explica o https→http", async () => {
    const porta = (mux.address() as { port: number }).port;
    const erro = await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto({ source: `https://127.0.0.1:${porta}/privado.git` }),
      () => {},
    ).then(
      () => null,
      (e: Error) => e,
    );
    expect(erro).not.toBeNull();
    expect(pedidosHttp.length).toBeGreaterThan(0);
    expect(pedidosHttp.every((p) => p.auth === "")).toBe(true);
    expect(JSON.stringify(pedidosHttp)).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    expect(erro?.message).toMatch(/https para http/i);
    expect(erro?.message).toMatch(/sem criptografia/i);
    expect(erro?.message).toMatch(/endereço final/i);
    expect(erro?.message).not.toContain(TOKEN);
  }, 30_000);
});
