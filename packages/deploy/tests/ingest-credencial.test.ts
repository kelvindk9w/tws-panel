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
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
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
  tmp = await mkdtemp(path.join(tmpdir(), "paas-cred-test-"));
  projectsDir = path.join(tmp, "projects");
  repoPublico = path.join(tmp, "publico");
  await criarRepo(repoPublico);

  const work = path.join(tmp, "origem");
  await criarRepo(work);
  bare = path.join(tmp, "privado.git");
  await git(["clone", "-q", "--bare", work, bare]);
  await git(["-C", bare, "update-server-info"]);

  server = http.createServer((req, res) => {
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

  it("remove o arquivo auxiliar do askpass ao terminar (sucesso e falha)", async () => {
    const antes = new Set(await readdir(tmpdir()));
    await ingestCode(
      comCredencial({ username: "x-access-token", token: TOKEN }),
      projeto(),
      () => {},
    );
    await expect(
      ingestCode(comCredencial({ username: "x-access-token", token: "errado" }), projeto({ slug: "outro" }), () => {}),
    ).rejects.toThrow();
    const depois = (await readdir(tmpdir())).filter((n) => !antes.has(n));
    expect(depois.filter((n) => n.startsWith("paas-git-cred-"))).toEqual([]);
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
