/**
 * "Testar acesso" — o que a revisão exigiu:
 *  1. prazo REAL: servidor que goteja bytes ou ssh que manda o banner e se cala
 *     não seguram a consulta além do prazo, e nenhum processo (com o token no
 *     ambiente) sobra depois — nem no fim normal;
 *  2. redirecionamento HTTP não leva o token a outro host;
 *  3. destinos internos (loopback, link-local, metadados) não são consultados;
 *  4. token informado em repositório público: avisa que não foi verificado.
 */
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCredential } from "@paas/core";

const chamadas: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
vi.mock("node:child_process", async () => {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...real,
    spawn: (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      chamadas.push({ file, args, ...(opts?.env ? { env: opts.env } : {}) });
      return (real.spawn as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

const { checkGitAccess, resolveTarget, classifyGitFailure, GIT_ACCESS_MESSAGES } = await import("../src/git-access.js");

const TOKEN = "ghp_TOKENISOLAMENTOsupersecreto0009";
const cred: GitReadCredential = { username: "x-access-token", token: TOKEN };

let tmp: string;
let bare: string;
let server: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;
let otherRequests: { url: string; auth: string }[];

async function git(args: string[]): Promise<void> {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  real.execFileSync("git", args, { stdio: "pipe" });
}

const listen = (s: http.Server | net.Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function processesWith(fragment: string): string[] {
  return execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(fragment) && !l.includes("ps -eo"));
}

beforeEach(async () => {
  chamadas.length = 0;
  otherRequests = [];
  tmp = await mkdtemp(path.join(tmpdir(), "paas-git-iso-"));
  const work = path.join(tmp, "work");
  await git(["init", "-q", "-b", "main", work]);
  await git(["-C", work, "config", "user.email", "t@example.com"]);
  await git(["-C", work, "config", "user.name", "T"]);
  await writeFile(path.join(work, "a.txt"), "x\n");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "i"]);
  bare = path.join(tmp, "repo.git");
  await git(["clone", "-q", "--bare", work, bare]);
  await git(["-C", bare, "update-server-info"]);

  other = http.createServer((req, res) => {
    otherRequests.push({ url: req.url ?? "", auth: req.headers.authorization ?? "" });
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    res.end("x");
  });
  otherBase = `http://127.0.0.1:${await listen(other)}`;

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x").pathname;
    const auth = req.headers.authorization ?? "";
    const serve = (rel: string) =>
      void stat(path.join(bare, rel))
        .then((st) => {
          if (!st.isFile()) throw new Error("x");
          res.writeHead(200);
          createReadStream(path.join(bare, rel)).pipe(res);
        })
        .catch(() => {
          res.writeHead(404);
          res.end("nf");
        });
    if (url.startsWith("/gotejo.git/")) {
      res.writeHead(200);
      const t = setInterval(() => res.write("0".repeat(400)), 100);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (url.startsWith("/vai.git/")) {
      res.writeHead(302, { Location: `${otherBase}${url.replace("/vai.git", "/privado.git")}` });
      return res.end();
    }
    if (url.startsWith("/publico.git/")) return serve(url.replace("/publico.git/", ""));
    if (url.startsWith("/privado.git/")) {
      if (!auth.startsWith("Basic ")) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        return res.end("auth");
      }
      return serve(url.replace("/privado.git/", ""));
    }
    res.writeHead(404);
    res.end("nf");
  });
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterEach(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("prazo real e processos órfãos", () => {
  it("servidor que goteja bytes sem parar: responde no prazo e não deixa git vivo com o token", async () => {
    const port = new URL(base).port;
    const t0 = Date.now();
    const r = await checkGitAccess({ source: `${base}/gotejo.git`, branch: null, credential: cred, timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(6_000);
    await pause(400);
    expect(processesWith(`127.0.0.1:${port}`)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  }, 30_000);

  it("ssh que manda o banner e se cala: responde no prazo e não deixa ssh vivo", async () => {
    const mute = net.createServer((sock) => {
      sock.write("SSH-2.0-OpenSSH_9.0\r\n");
    });
    const port = await listen(mute);
    const t0 = Date.now();
    const r = await checkGitAccess({ source: `ssh://git@127.0.0.1:${port}/dono/repo.git`, branch: null, credential: null, timeoutMs: 2_000 });
    mute.close();
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(6_000);
    await pause(400);
    expect(processesWith(`-p ${port} `)).toEqual([]);
  }, 30_000);

  it("fim normal também não deixa filho", async () => {
    const port = new URL(base).port;
    await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred });
    await pause(300);
    expect(processesWith(`127.0.0.1:${port}`)).toEqual([]);
  }, 30_000);

  it("ssh leva ServerAliveInterval e ServerAliveCountMax além de BatchMode", async () => {
    await checkGitAccess({ source: "ssh://git@127.0.0.1:1/dono/repo.git", branch: null, credential: null, timeoutMs: 5_000 });
    expect(chamadas.at(-1)?.env?.GIT_SSH_COMMAND).toMatch(/BatchMode=yes.*ServerAliveInterval=\d+.*ServerAliveCountMax=\d+/);
  }, 30_000);

  it("git ausente do PATH: falha reconhecida como desconhecida, sem travar nem vazar", async () => {
    const path0 = process.env.PATH;
    process.env.PATH = "/nao-existe";
    try {
      const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: cred, timeoutMs: 5_000 });
      expect(r).toMatchObject({ ok: false, reason: "unknown" });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    } finally {
      process.env.PATH = path0;
    }
  });

  it("proxy herdado do ambiente é ignorado: a consulta vai direto ao endereço conferido", async () => {
    const antes = { http: process.env.http_proxy, HTTP: process.env.HTTP_PROXY, all: process.env.ALL_PROXY };
    process.env.http_proxy = "http://127.0.0.1:1";
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.ALL_PROXY = "http://127.0.0.1:1";
    try {
      const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null, timeoutMs: 10_000 });
      expect(r.ok).toBe(true);
      expect(chamadas.at(-1)?.env?.http_proxy).toBeUndefined();
      expect(chamadas.at(-1)?.env?.HTTP_PROXY).toBeUndefined();
      expect(chamadas.at(-1)?.env?.ALL_PROXY).toBeUndefined();
    } finally {
      for (const [k, v] of [["http_proxy", antes.http], ["HTTP_PROXY", antes.HTTP], ["ALL_PROXY", antes.all]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);
});

describe("redirecionamento não leva o token a outro host", () => {
  it("302 do host A para B: B não recebe nada e o resultado explica o redirecionamento", async () => {
    const r = await checkGitAccess({ source: `${base}/vai.git`, branch: null, credential: cred });
    expect(r).toMatchObject({ ok: false, reason: "redirected" });
    expect(otherRequests).toEqual([]);
    expect(chamadas.at(-1)?.args.join(" ")).toContain("http.followRedirects=false");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  }, 30_000);

  it("SEM token o teste também NÃO segue redirecionamento (nada de SSRF por redirect para destino interno)", async () => {
    const r = await checkGitAccess({ source: `${base}/vai.git`, branch: null, credential: null });
    expect(r).toMatchObject({ ok: false, reason: "redirected" });
    expect(otherRequests).toEqual([]);
    expect(chamadas.at(-1)?.args.join(" ")).toContain("http.followRedirects=false");
  }, 30_000);

  it("a mensagem do redirecionamento cita o endereço final e a falta do .git", () => {
    expect(GIT_ACCESS_MESSAGES.redirected).toMatch(/\.git/);
    expect(GIT_ACCESS_MESSAGES.redirected).toMatch(/endereço final/);
  });

  it("classifyGitFailure reconhece a recusa do redirecionamento", () => {
    expect(classifyGitFailure("warning: redirecting to https://x/y.git/\nfatal: unable to update url base from redirection", true)).toBe("redirected");
    expect(classifyGitFailure("fatal: redirecting to https://x/y.git/", false)).toBe("redirected");
  });
});

describe("token informado em repositório público", () => {
  it("o git não o enviou: tokenUsed false", async () => {
    expect(await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: cred })).toMatchObject({ ok: true, tokenUsed: false });
  }, 30_000);

  it("repositório que pede autenticação: tokenUsed true", async () => {
    expect(await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred })).toMatchObject({ ok: true, tokenUsed: true });
  }, 30_000);

  it("sem token: tokenUsed null; o marcador do helper não vaza para o detalhe", async () => {
    expect(await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null })).toMatchObject({ ok: true, tokenUsed: null });
    const r = await checkGitAccess({ source: `${base}/inexistente.git`, branch: null, credential: cred });
    expect(JSON.stringify(r)).not.toContain("paas-credential-used");
  }, 30_000);
});

describe("resolveTarget — destinos que o teste não consulta", () => {
  const publicLookup = async () => [{ address: "203.0.113.7", family: 4 }];

  it.each([
    "https://127.0.0.1/r.git",
    "https://127.1.2.3/r.git",
    "https://0.0.0.0/r.git",
    "https://169.254.169.254/latest",
    "https://[::1]/r.git",
    "https://[::]/r.git",
    "https://[fe80::1]/r.git",
    "https://[::ffff:127.0.0.1]/r.git",
    "https://[::ffff:169.254.169.254]/r.git",
    "https://localhost/r.git",
    "https://app.localhost/r.git",
    "ssh://git@127.0.0.1/r.git",
    "git@169.254.169.254:dono/r.git",
    "https://usuario:senha@127.0.0.1:8443/r.git",
  ])("recusa %s", async (source) => {
    expect(await resolveTarget(source, publicLookup)).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("recusa nome que resolve para interno (basta um dos endereços)", async () => {
    const mixed = async () => [
      { address: "203.0.113.7", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    expect(await resolveTarget("https://rebind.example.com/r.git", mixed)).toEqual({ ok: false, reason: "blocked_host" });
    const meta = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await resolveTarget("https://meta.example.com/r.git", meta)).toEqual({ ok: false, reason: "blocked_host" });
  });

  it("redes privadas continuam permitidas (Git interno legítimo)", async () => {
    for (const ip of ["10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.10"]) {
      expect(await resolveTarget(`https://${ip}/r.git`, publicLookup)).toMatchObject({ ok: true });
    }
    expect(await resolveTarget("https://git.interno.example.com/r.git", async () => [{ address: "10.0.0.7", family: 4 }])).toMatchObject({ ok: true });
  });

  it("nome público: fixa o endereço resolvido (anti-rebinding) como host:porta:ip", async () => {
    expect(await resolveTarget("https://git.example.com/r.git", publicLookup)).toEqual({ ok: true, pin: "git.example.com:443:203.0.113.7" });
    expect(await resolveTarget("https://git.example.com:8443/r.git", publicLookup)).toEqual({ ok: true, pin: "git.example.com:8443:203.0.113.7" });
    const both = async () => [
      { address: "2001:db8::1", family: 6 },
      { address: "203.0.113.7", family: 4 },
    ];
    expect(await resolveTarget("https://git.example.com/r.git", both)).toEqual({ ok: true, pin: "git.example.com:443:[2001:db8::1],203.0.113.7" });
  });

  it("IP público literal, ssh e scp: permitidos, sem fixar nada", async () => {
    expect(await resolveTarget("https://203.0.113.7/r.git", publicLookup)).toEqual({ ok: true, pin: null });
    expect(await resolveTarget("ssh://git@git.example.com/r.git", publicLookup)).toEqual({ ok: true, pin: null });
    expect(await resolveTarget("git@git.example.com:dono/r.git", publicLookup)).toEqual({ ok: true, pin: null });
  });

  it("nome que não resolve: inacessível, sem rodar o git", async () => {
    const fail = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await resolveTarget("https://nao-existe.example.com/r.git", fail)).toEqual({ ok: false, reason: "unreachable" });
    expect(await resolveTarget("https://vazio.example.com/r.git", async () => [])).toEqual({ ok: false, reason: "unreachable" });
  });

  it("endereço sem host reconhecível: recusa", async () => {
    expect(await resolveTarget("https://", publicLookup)).toEqual({ ok: false, reason: "invalid_source" });
    expect(await resolveTarget("lixo", publicLookup)).toEqual({ ok: false, reason: "invalid_source" });
  });

  it("o pin vira -c http.curloptResolve na consulta", async () => {
    await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null, pin: "exemplo.invalid:80:127.0.0.1" });
    expect(chamadas.at(-1)?.args.join(" ")).toContain("http.curloptResolve=exemplo.invalid:80:127.0.0.1");
  }, 30_000);
});

describe("credentialHost — a quem o helper entrega o token", () => {
  it("host[:porta] em minúsculas, porta padrão omitida; vazio se não for URL (o helper então não responde a ninguém)", async () => {
    const { credentialHost } = await import("../src/git-safe.js");
    expect(credentialHost("https://GitLab.Example.com/dono/repo")).toBe("gitlab.example.com");
    expect(credentialHost("https://git.example.com:8443/r.git")).toBe("git.example.com:8443");
    expect(credentialHost("https://git.example.com:443/r.git")).toBe("git.example.com");
    expect(credentialHost("git@git.example.com:dono/r.git")).toBe("");
    expect(credentialHost("lixo")).toBe("");
  });
});

describe("credentialHelper — só entrega o token no protocolo cadastrado", () => {
  async function pedir(registrado: string, pedido: { protocol: string; host: string }): Promise<string> {
    const { spawnSync } = await import("node:child_process");
    const { credentialHelper, credentialHost, credentialProtocol } = await import("../src/git-safe.js");
    const r = spawnSync("sh", ["-c", `${credentialHelper().slice(1)} get`], {
      input: `protocol=${pedido.protocol}\nhost=${pedido.host}\n\n`,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PAAS_GIT_USERNAME: "x-access-token",
        PAAS_GIT_PASSWORD: "segredo-de-teste",
        PAAS_GIT_HOST: credentialHost(registrado),
        PAAS_GIT_PROTOCOL: credentialProtocol(registrado),
      },
    });
    return r.stdout;
  }

  it("credentialProtocol: https/http em minúsculas; vazio se não for URL", async () => {
    const { credentialProtocol } = await import("../src/git-safe.js");
    expect(credentialProtocol("HTTPS://git.example.com/r.git")).toBe("https");
    expect(credentialProtocol("http://git.example.com/r.git")).toBe("http");
    expect(credentialProtocol("lixo")).toBe("");
  });

  it("cadastro https: protocol=https entrega, protocol=http NÃO entrega", async () => {
    const url = "https://git.example.com/r.git";
    expect(await pedir(url, { protocol: "https", host: "git.example.com" })).toContain("password=segredo-de-teste");
    expect(await pedir(url, { protocol: "http", host: "git.example.com" })).toBe("");
  });

  it("cadastro http: http entrega e https também (subir a proteção é permitido)", async () => {
    const url = "http://git.example.com/r.git";
    expect(await pedir(url, { protocol: "http", host: "git.example.com" })).toContain("password=");
    expect(await pedir(url, { protocol: "https", host: "git.example.com" })).toContain("password=");
  });

  it("protocolo qualquer outro (ftp, vazio) nunca recebe", async () => {
    const url = "https://git.example.com/r.git";
    expect(await pedir(url, { protocol: "ftp", host: "git.example.com" })).toBe("");
    expect(await pedir(url, { protocol: "", host: "git.example.com" })).toBe("");
  });
});
