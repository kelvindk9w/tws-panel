/**
 * "Testar acesso" do assistente Novo projeto: uma consulta SOMENTE LEITURA
 * (`git ls-remote`) ao repositório, com o token digitado, que diz se o
 * painel conseguirá clonar — sem clonar, sem gravar nada.
 *
 * Os repositórios do teste são servidos por um servidor HTTP falso (git dumb
 * HTTP sobre repositórios bare) que reproduz os casos reais: token certo,
 * token recusado (401), token sem permissão (403), repositório inexistente
 * (404), repositório público e servidor que não responde.
 *
 * Contrato inegociável: o token NUNCA aparece em argumento de processo
 * (`ps` do host), em resposta, em detalhe de erro nem em arquivo criado.
 */
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReadCredential } from "@paas/core";

const chamadas: { file: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }[] = [];
// o teste observa o que o painel executa (spawn); o git roda de verdade
vi.mock("node:child_process", async () => {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...real,
    spawn: (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      chamadas.push({ file, args, ...(opts?.env ? { env: opts.env } : {}), ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return (real.spawn as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

const { checkGitAccess, classifyGitFailure, GIT_ACCESS_MESSAGES, parseHeads, sanitizeDetail, resolveTarget } = await import(
  "../src/git-access.js"
);

const TOKEN = "ghp_TOKENDETESTEsupersecreto0002";
const cred: GitReadCredential = { username: "x-access-token", token: TOKEN };

let tmp: string;
let bare: string;
let server: http.Server;
let base: string;
let pedidos: { url: string; auth: string }[];
// segundo servidor: destino de um redirecionamento (não pode receber o token)
let outro: string;
let outroServer: http.Server;
let outroPedidos: { url: string; auth: string }[];

async function git(args: string[]): Promise<void> {
  const { run } = await vi.importActual<typeof import("../src/exec.js")>("../src/exec.js");
  const r = await run("git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} falhou: ${r.stderr}`);
}

async function criarBare(dir: string, ramos: string[]): Promise<void> {
  const work = `${dir}-work`;
  await git(["init", "-q", "-b", "main", work]);
  await git(["-C", work, "config", "user.email", "teste@exemplo.com"]);
  await git(["-C", work, "config", "user.name", "Teste"]);
  await writeFile(path.join(work, "a.txt"), "x\n");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "inicial"]);
  for (const r of ramos) await git(["-C", work, "branch", r]);
  await git(["clone", "-q", "--bare", work, dir]);
  await git(["-C", dir, "update-server-info"]);
}

function servir(raiz: string, rel: string, res: http.ServerResponse): void {
  const alvo = path.join(raiz, rel);
  void stat(alvo)
    .then((st) => {
      if (!st.isFile()) throw new Error("não é arquivo");
      res.writeHead(200);
      createReadStream(alvo).pipe(res);
    })
    .catch(() => {
      res.writeHead(404);
      res.end("não encontrado");
    });
}

beforeEach(async () => {
  chamadas.length = 0;
  pedidos = [];
  tmp = await mkdtemp(path.join(tmpdir(), "paas-git-access-"));
  bare = path.join(tmp, "repo.git");
  await criarBare(bare, ["develop", "feature/x"]);

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x").pathname;
    const auth = req.headers.authorization ?? "";
    pedidos.push({ url, auth });
    const senha = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8").split(":")[1] : null;

    if (url.startsWith("/lento.git/")) return; // nunca responde
    if (url.startsWith("/gotejo.git/")) {
      // goteja ~4 KB/s para sempre: fica acima do limite de velocidade mínima do curl
      res.writeHead(200);
      const t = setInterval(() => res.write("0".repeat(400)), 100);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (url.startsWith("/vai.git/")) {
      res.writeHead(302, { Location: `${outro}${url.replace("/vai.git", "/privado.git")}` });
      return res.end();
    }
    if (url.startsWith("/quebrado.git/")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("isto não é um repositório git\n");
    }
    if (url.startsWith("/publico.git/")) return servir(bare, url.replace("/publico.git/", ""), res);
    if (url.startsWith("/privado.git/") || url.startsWith("/restrito.git/")) {
      if (senha === null) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        return res.end("autenticação necessária");
      }
      if (url.startsWith("/restrito.git/")) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      if (senha !== TOKEN) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
        return res.end("bad credentials");
      }
      return servir(bare, url.replace("/privado.git/", ""), res);
    }
    res.writeHead(404);
    res.end("repository not found");
  });
  outroPedidos = [];
  outroServer = http.createServer((req, res) => {
    outroPedidos.push({ url: req.url ?? "", auth: req.headers.authorization ?? "" });
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
    res.end("x");
  });
  await new Promise<void>((resolve) => outroServer.listen(0, "127.0.0.1", resolve));
  const oa = outroServer.address();
  outro = `http://127.0.0.1:${typeof oa === "object" && oa ? oa.port : 0}`;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  outroServer.closeAllConnections();
  await new Promise<void>((resolve) => outroServer.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmp, { recursive: true, force: true });
});

describe("checkGitAccess — resultados", () => {
  it("ok: repositório privado com o token certo lista as branches e a padrão", async () => {
    const r = await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred });
    expect(r).toMatchObject({ ok: true, defaultBranch: "main", totalBranches: 3, branchFound: null });
    if (r.ok) expect(r.branches).toEqual(["main", "develop", "feature/x"]);
  }, 30_000);

  it("ok: repositório público, sem token", async () => {
    const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null });
    expect(r).toMatchObject({ ok: true, defaultBranch: "main" });
  }, 30_000);

  it("ok com branch pedida que existe", async () => {
    const r = await checkGitAccess({ source: `${base}/privado.git`, branch: "feature/x", credential: cred });
    expect(r).toMatchObject({ ok: true, branchFound: true });
  }, 30_000);

  it("limita a lista curta de branches e informa o total", async () => {
    const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null, maxBranches: 2 });
    expect(r).toMatchObject({ ok: true, totalBranches: 3 });
    if (r.ok) expect(r.branches).toEqual(["main", "develop"]);
  }, 30_000);

  it("branch que não existe: diz quais existem e qual é a padrão", async () => {
    const r = await checkGitAccess({ source: `${base}/privado.git`, branch: "nao-existe", credential: cred });
    expect(r).toMatchObject({ ok: false, reason: "branch_not_found", defaultBranch: "main" });
    if (!r.ok) expect(r.branches).toContain("develop");
  }, 30_000);

  it("token recusado (401): inválido ou expirado", async () => {
    const r = await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: { username: "x", token: "outro-token-errado" } });
    expect(r).toMatchObject({ ok: false, reason: "invalid_token" });
  }, 30_000);

  it("repositório privado sem token: pede autenticação", async () => {
    const r = await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: null });
    expect(r).toMatchObject({ ok: false, reason: "auth_required" });
  }, 30_000);

  it("token sem permissão de leitura (403)", async () => {
    const r = await checkGitAccess({ source: `${base}/restrito.git`, branch: null, credential: cred });
    expect(r).toMatchObject({ ok: false, reason: "no_permission" });
  }, 30_000);

  it("repositório que não existe: sem token é 'não existe'; com token é 'não existe ou o token não enxerga'", async () => {
    expect(await checkGitAccess({ source: `${base}/fantasma.git`, branch: null, credential: null })).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await checkGitAccess({ source: `${base}/fantasma.git`, branch: null, credential: cred })).toMatchObject({
      ok: false,
      reason: "not_found_or_no_access",
    });
  }, 30_000);

  it("servidor que não responde: tempo esgotado", async () => {
    const r = await checkGitAccess({ source: `${base}/lento.git`, branch: null, credential: null, timeoutMs: 1_500 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  }, 30_000);

  it("host que não existe ou porta fechada: inacessível", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null });
    expect(r).toMatchObject({ ok: false, reason: "unreachable" });
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }, 30_000);

  it("token com endereço ssh não faz sentido: não consulta nada", async () => {
    const r = await checkGitAccess({ source: "git@exemplo.invalid:dono/repo.git", branch: null, credential: cred });
    expect(r).toMatchObject({ ok: false, reason: "token_not_applicable" });
    expect(chamadas).toHaveLength(0);
  });

  it("endereço que começa com '-' é recusado sem rodar o git", async () => {
    const r = await checkGitAccess({ source: "--upload-pack=touch /tmp/x", branch: null, credential: null });
    expect(r).toMatchObject({ ok: false, reason: "invalid_source" });
    expect(chamadas).toHaveLength(0);
  });

  it("repositório vazio: ok, sem branches", async () => {
    const vazio = path.join(tmp, "vazio.git");
    await git(["init", "-q", "--bare", "-b", "main", vazio]);
    await git(["-C", vazio, "update-server-info"]);
    bare = vazio;
    const r = await checkGitAccess({ source: `${base}/publico.git`, branch: null, credential: null });
    expect(r).toMatchObject({ ok: true, totalBranches: 0, branches: [], defaultBranch: null });
    const r2 = await checkGitAccess({ source: `${base}/publico.git`, branch: "main", credential: null });
    expect(r2).toMatchObject({ ok: false, reason: "branch_not_found" });
  }, 30_000);
});

describe("checkGitAccess — o token nunca vaza", () => {
  it("não aparece em nenhum argumento de processo, e o git roda sem prompt e fora de qualquer repositório", async () => {
    await checkGitAccess({ source: `${base}/privado.git`, branch: "main", credential: cred });
    await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: { username: "x", token: "errado-123456" } });
    expect(chamadas.length).toBeGreaterThan(0);
    for (const c of chamadas) {
      for (const arg of [c.file, ...c.args]) {
        expect(arg).not.toContain(TOKEN);
        expect(arg).not.toContain("errado-123456");
      }
      expect(c.args).toContain("ls-remote");
      expect(c.args).not.toContain("clone");
      expect(c.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env?.GIT_ASKPASS).toBe("");
      expect(c.cwd).toBeTruthy();
    }
  }, 30_000);

  it("enquanto o git roda, o token não está em nenhuma linha de comando do sistema (ps)", async () => {
    const pendente = checkGitAccess({ source: `${base}/lento.git`, branch: null, credential: cred, timeoutMs: 2_500 });
    const vistos: string[] = [];
    const fim = Date.now() + 1_800;
    while (Date.now() < fim) {
      vistos.push(execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }));
      await new Promise((r) => setTimeout(r, 150));
    }
    const todos = vistos.join("\n");
    expect(todos).toContain("ls-remote"); // o git estava de fato rodando durante a amostragem
    expect(todos).not.toContain(TOKEN);
    expect(await pendente).toMatchObject({ ok: false, reason: "timeout" });
  }, 30_000);

  it("não aparece no resultado nem no detalhe de erro, mesmo em falha inesperada", async () => {
    const respostas = [
      await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred }),
      await checkGitAccess({ source: `${base}/privado.git`, branch: "x", credential: cred }),
      await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: { username: "x", token: "errado-123456" } }),
      await checkGitAccess({ source: `${base}/restrito.git`, branch: null, credential: cred }),
    ];
    const texto = JSON.stringify(respostas);
    expect(texto).not.toContain(TOKEN);
    expect(texto).not.toContain("errado-123456");
  }, 60_000);

  it("não cria arquivo nenhum no diretório temporário do sistema", async () => {
    const antes = new Set(await readdir(tmpdir()));
    await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred });
    const novos = (await readdir(tmpdir())).filter((n) => !antes.has(n) && !n.startsWith("paas-git-access-"));
    expect(novos).toEqual([]);
  }, 30_000);

  it("o servidor recebe o token (a credencial funciona) mas só por cabeçalho Basic", async () => {
    await checkGitAccess({ source: `${base}/privado.git`, branch: null, credential: cred });
    expect(pedidos.some((p) => p.auth.startsWith("Basic "))).toBe(true);
    expect(pedidos.every((p) => !p.url.includes(TOKEN))).toBe(true);
  }, 30_000);
});

describe("classifyGitFailure — mensagens reais de GitHub, GitLab e ssh", () => {
  const com = (s: string) => classifyGitFailure(s, true);
  const sem = (s: string) => classifyGitFailure(s, false);

  it("token inválido ou expirado", () => {
    expect(
      com("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'"),
    ).toBe("invalid_token");
    expect(com("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/o/r.git/'")).toBe("invalid_token");
    expect(com("fatal: unable to access 'https://x/': The requested URL returned error: 401")).toBe("invalid_token");
  });

  it("repositório que pede autenticação sem token", () => {
    expect(sem("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth_required");
    expect(sem("fatal: Authentication failed for 'https://x/'")).toBe("auth_required");
  });

  it("sem permissão", () => {
    expect(com("remote: Permission to o/r.git denied to alguem.\nfatal: unable to access 'https://x/': The requested URL returned error: 403")).toBe("no_permission");
    expect(com("git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("no_permission");
    expect(sem("remote: You are not allowed to download code from this project.\nfatal: unable to access 'https://x/': The requested URL returned error: 403")).toBe("no_permission");
  });

  it("não encontrado", () => {
    expect(sem("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).toBe("not_found");
    expect(com("remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found")).toBe("not_found_or_no_access");
    expect(sem("fatal: unable to access 'https://x/': The requested URL returned error: 404")).toBe("not_found");
    expect(sem("fatal: '/x' does not appear to be a git repository")).toBe("not_found");
  });

  it("host inacessível", () => {
    expect(sem("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe("unreachable");
    expect(sem("fatal: unable to access 'https://x/': Failed to connect to x port 443 after 3 ms: Couldn't connect to server")).toBe("unreachable");
    expect(sem("ssh: Could not resolve hostname x: Name or service not known\nfatal: Could not read from remote repository.")).toBe("unreachable");
    expect(sem("fatal: unable to access 'https://x/': SSL certificate problem: self-signed certificate")).toBe("unreachable");
    expect(sem("Host key verification failed.\nfatal: Could not read from remote repository.")).toBe("unreachable");
  });

  it("tempo esgotado", () => {
    expect(sem('Falha ao executar "git": Command failed — processo encerrado pelo sinal SIGTERM')).toBe("timeout");
    expect(sem("fatal: unable to access 'https://x/': Connection timed out after 10001 milliseconds")).toBe("timeout");
    expect(sem("fatal: unable to access 'https://x/': Operation too slow. Less than 1000 bytes/sec transferred the last 10 seconds")).toBe("timeout");
  });

  it("protocolo não suportado", () => {
    expect(sem("fatal: transport 'ext' not allowed")).toBe("unsupported_host");
    expect(sem("fatal: Unable to find remote helper for 'ftp'")).toBe("unsupported_host");
  });

  it("o que não se reconhece vira unknown", () => {
    expect(sem("algo completamente diferente")).toBe("unknown");
    expect(sem("")).toBe("unknown");
  });
});

describe("mensagens em português", () => {
  it("há uma mensagem para cada motivo e nenhuma menciona token real", () => {
    for (const [reason, msg] of Object.entries(GIT_ACCESS_MESSAGES)) {
      expect(msg.length, reason).toBeGreaterThan(10);
      expect(msg).not.toContain(TOKEN);
    }
  });
});

describe("casos de borda", () => {
  it("resposta que o git não entende: unknown, com uma linha de detalhe e sem o token", async () => {
    const r = await checkGitAccess({ source: `${base}/quebrado.git`, branch: null, credential: cred });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(["unknown", "not_found_or_no_access"]).toContain(r.reason);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      if (r.reason === "unknown") expect(r.detail?.length ?? 0).toBeLessThanOrEqual(200);
    }
  }, 30_000);

  it("endereço ssh sem token roda com BatchMode e falha como inacessível, sem pendurar", async () => {
    const r = await checkGitAccess({ source: "ssh://git@127.0.0.1:1/dono/repo.git", branch: null, credential: null, timeoutMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(chamadas.at(-1)?.env?.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  }, 30_000);

  it("parseHeads sem symref: a padrão é a branch que aponta para o mesmo commit do HEAD (main > master)", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const out = `${a}\tHEAD\n${b}\trefs/heads/dev\n${a}\trefs/heads/master\n${a}\trefs/heads/main\n`;
    expect(parseHeads(out)).toEqual({ branches: ["main", "dev", "master"], defaultBranch: "main" });
    expect(parseHeads(`${a}\tHEAD\n${a}\trefs/heads/master\n`).defaultBranch).toBe("master");
    expect(parseHeads(`${a}\tHEAD\n${a}\trefs/heads/zeta\n`).defaultBranch).toBe("zeta");
  });

  it("parseHeads ignora linhas que não são branch e HEAD sem correspondência", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(parseHeads(`ref: refs/heads/sumiu\tHEAD\n${a}\tHEAD\n${b}\trefs/tags/v1\nlixo\n${b}\trefs/heads/x\n`)).toEqual({
      branches: ["x"],
      defaultBranch: null,
    });
    expect(parseHeads("")).toEqual({ branches: [], defaultBranch: null });
  });

  it("sanitizeDetail tira o token e o usuário:senha da URL e fica com a última linha, curta", () => {
    const texto = `linha antiga\nfatal: unable to access 'https://dono:${TOKEN}@host.example.com/r.git/': ${TOKEN} falhou\n\n`;
    const limpo = sanitizeDetail(texto, TOKEN);
    expect(limpo).not.toContain(TOKEN);
    expect(limpo).not.toContain("dono:");
    expect(limpo).toContain("host.example.com");
    expect(sanitizeDetail("", null)).toBe("");
    expect(sanitizeDetail("x".repeat(500), null)).toHaveLength(200);
  });
});
