/**
 * Base do alerta de "nova atualização": o commit da ponta de uma branch no repositório remoto
 * (`remoteBranchCommit`, `ls-remote` sem clonar) e o commit que o deploy deixou no ar
 * (`readDeployedCommit`). Tudo contra repositórios locais de verdade e servidores HTTP locais,
 * sem rede externa.
 */
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { remoteBranchCommit } from "../src/git-access.js";
import { ingestCode, readDeployedCommit } from "../src/ingest.js";
import { run } from "../src/exec.js";

const TOKEN = "tkn_TOKENDEATUALIZACAOsupersecreto0042";
const cred = { username: "x-access-token", token: TOKEN };

let tmp: string;
let repo: string;
let projectsDir: string;

const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args]);
async function head(dir: string, ref: string): Promise<string> {
  return (await git(dir, "rev-parse", ref)).stdout.trim();
}
async function commitNaBranch(dir: string, branch: string, texto: string): Promise<void> {
  await git(dir, "checkout", "-q", branch);
  await writeFile(path.join(dir, "arquivo.txt"), `${texto}\n`);
  await git(dir, "commit", "-q", "-am", texto);
  await git(dir, "checkout", "-q", "main");
}

function projeto(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "App",
    slug: "app",
    ingestMode: "git",
    source: repo,
    branch: "main",
    domain: "app.example.com",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...overrides,
  } as Project;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-update-check-"));
  repo = path.join(tmp, "repo");
  projectsDir = path.join(tmp, "projects");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "teste@example.com");
  await git(repo, "config", "user.name", "Teste");
  await writeFile(path.join(repo, "arquivo.txt"), "main 1\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "main 1");
  await git(repo, "checkout", "-q", "-b", "sandbox");
  await commitNaBranch(repo, "sandbox", "sandbox 1");
  // uma branch cujo NOME termina em "/main" não pode ser confundida com a main
  await git(repo, "branch", "feature/main", "sandbox");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("remoteBranchCommit", () => {
  it("devolve a ponta da branch pedida; branches diferentes do mesmo repositório têm commits diferentes", async () => {
    const main = await remoteBranchCommit({ source: repo, branch: "main", credential: null });
    const sandbox = await remoteBranchCommit({ source: repo, branch: "sandbox", credential: null });
    expect(main).toEqual({ ok: true, commit: await head(repo, "main") });
    expect(sandbox).toEqual({ ok: true, commit: await head(repo, "sandbox") });
    expect(main).not.toEqual(sandbox);
  });

  it("acompanha um commit novo", async () => {
    const antes = await remoteBranchCommit({ source: repo, branch: "main", credential: null });
    await commitNaBranch(repo, "main", "main 2");
    const depois = await remoteBranchCommit({ source: repo, branch: "main", credential: null });
    expect(depois).toEqual({ ok: true, commit: await head(repo, "main") });
    expect(depois).not.toEqual(antes);
  });

  it("branch que não existe no repositório é branch_not_found (e não sucesso)", async () => {
    expect(await remoteBranchCommit({ source: repo, branch: "nao-existe", credential: null })).toEqual({
      ok: false,
      reason: "branch_not_found",
    });
  });

  it("repositório inexistente falha com motivo, nunca com commit", async () => {
    const r = await remoteBranchCommit({ source: path.join(tmp, "nada.git"), branch: "main", credential: null });
    expect(r.ok).toBe(false);
  });

  it("endereço começando com '-' é recusado sem chamar o git", async () => {
    expect(await remoteBranchCommit({ source: "--upload-pack=x", branch: "main", credential: null })).toEqual({
      ok: false,
      reason: "invalid_source",
    });
  });

  it("token em endereço ssh não é aplicável", async () => {
    expect(
      await remoteBranchCommit({ source: "git@example.com:dono/repo.git", branch: "main", credential: cred }),
    ).toEqual({ ok: false, reason: "token_not_applicable" });
  });

  it("falha por rede esgotada é timeout e não deixa o token no resultado", async () => {
    // servidor que aceita a conexão e nunca responde
    const abertos: net.Socket[] = [];
    const mudo = net.createServer((sock) => void abertos.push(sock));
    const porta = await new Promise<number>((r) => mudo.listen(0, "127.0.0.1", () => r((mudo.address() as net.AddressInfo).port)));
    try {
      const r = await remoteBranchCommit({
        source: `http://127.0.0.1:${porta}/dono/repo.git`,
        branch: "main",
        credential: cred,
        timeoutMs: 1_000,
      });
      expect(r).toEqual({ ok: false, reason: "timeout" });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    } finally {
      abertos.forEach((sock) => sock.destroy());
      await new Promise<void>((r) => mudo.close(() => r()));
    }
  }, 20_000);

  describe("HTTP", () => {
    let origem: http.Server;
    let destino: http.Server;
    let pedidosDestino: { auth: string }[];

    const listen = (s: http.Server) =>
      new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port)));

    beforeEach(async () => {
      pedidosDestino = [];
      destino = http.createServer((req, res) => {
        pedidosDestino.push({ auth: req.headers.authorization ?? "" });
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
        res.end("x");
      });
      const portaDestino = await listen(destino);
      origem = http.createServer((req, res) => {
        if ((req.url ?? "").startsWith("/vai.git/")) {
          res.writeHead(302, { Location: `http://127.0.0.1:${portaDestino}${req.url}` });
          return res.end();
        }
        // repositório privado que recusa o token
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' });
        res.end("auth");
      });
    });

    afterEach(async () => {
      for (const s of [origem, destino]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    });

    it("redirecionamento não é seguido: motivo 'redirected' e o outro host não recebe o token", async () => {
      const porta = await listen(origem);
      const r = await remoteBranchCommit({
        source: `http://127.0.0.1:${porta}/vai.git`,
        branch: "main",
        credential: cred,
        timeoutMs: 10_000,
      });
      expect(r).toEqual({ ok: false, reason: "redirected" });
      expect(pedidosDestino).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }, 20_000);

    it("repositório que recusa o token: motivo de credencial, sem vazar o token", async () => {
      const porta = await listen(origem);
      const r = await remoteBranchCommit({
        source: `http://127.0.0.1:${porta}/privado.git`,
        branch: "main",
        credential: cred,
        timeoutMs: 10_000,
      });
      expect(r).toEqual({ ok: false, reason: "invalid_token" });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }, 20_000);

    it("sem token em repositório privado: auth_required", async () => {
      const porta = await listen(origem);
      const r = await remoteBranchCommit({
        source: `http://127.0.0.1:${porta}/privado.git`,
        branch: "main",
        credential: null,
        timeoutMs: 10_000,
      });
      expect(r).toEqual({ ok: false, reason: "auth_required" });
    }, 20_000);
  });
});

describe("readDeployedCommit", () => {
  it("devolve o commit que a ingestão deixou no ar, e muda quando a ingestão traz commit novo", async () => {
    const p = projeto({ branch: "sandbox" });
    await ingestCode({ projectsDir }, p, () => {});
    expect(await readDeployedCommit({ projectsDir }, p)).toBe(await head(repo, "sandbox"));

    await commitNaBranch(repo, "sandbox", "sandbox 2");
    await ingestCode({ projectsDir }, p, () => {});
    expect(await readDeployedCommit({ projectsDir }, p)).toBe(await head(repo, "sandbox"));
  });

  it("dois projetos com o mesmo repositório e branches diferentes guardam commits diferentes", async () => {
    const prod = projeto({ id: "prod", slug: "prod", branch: "main" });
    const sbx = projeto({ id: "sbx", slug: "sbx", branch: "sandbox" });
    await ingestCode({ projectsDir }, prod, () => {});
    await ingestCode({ projectsDir }, sbx, () => {});
    const a = await readDeployedCommit({ projectsDir }, prod);
    const b = await readDeployedCommit({ projectsDir }, sbx);
    expect(a).toBe(await head(repo, "main"));
    expect(b).toBe(await head(repo, "sandbox"));
    expect(a).not.toBe(b);
  });

  it("null quando o projeto não é git ou ainda não tem repositório do painel", async () => {
    expect(await readDeployedCommit({ projectsDir }, projeto({ ingestMode: "upload" }))).toBeNull();
    expect(await readDeployedCommit({ projectsDir }, projeto())).toBeNull();
  });

  it("null (e não erro) quando o identificador do projeto é inválido", async () => {
    expect(await readDeployedCommit({ projectsDir }, projeto({ id: "../x", storageLayout: "reserved" }))).toBeNull();
  });
});
