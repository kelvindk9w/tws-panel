/**
 * Linha de comando e saída do ls-remote do "Testar acesso" e do alerta de atualização: trava as
 * proteções que precisam ir no argv (`--symref` só no teste de acesso, `--` antes do endereço,
 * helper de credencial herdado zerado antes do nosso, proxy vazio) e que o detalhe de uma falha
 * desconhecida sai sem usuário:senha da URL e sem o token.
 */
import http from "node:http";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: { file: string; args: string[] }[] = [];
vi.mock("node:child_process", async () => {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...real,
    spawn: (file: string, args: string[], opts?: unknown) => {
      chamadas.push({ file, args });
      // endereço-isca: no lugar do git, um processo que falha ecoando URL com usuário:senha e o token
      if (args.some((a) => a.includes("eco-do-token.example.com"))) {
        const eco = "fatal: estranho https://u:tkn_TOKENARGVsupersecreto000000000001@h.example.com/x e tkn_TOKENARGVsupersecreto000000000001";
        return (real.spawn as (...a: unknown[]) => unknown)(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(eco)});process.exit(128)`], opts);
      }
      return (real.spawn as (...a: unknown[]) => unknown)(file, args, opts);
    },
  };
});

const { checkGitAccess, remoteBranchCommit, sanitizeDetail } = await import("../src/git-access.js");

const TOKEN = "tkn_TOKENARGVsupersecreto000000000001";
const cred = { username: "x-access-token", token: TOKEN };

let server: http.Server;
let base: string;

beforeEach(async () => {
  chamadas.length = 0;
  // devolve 500 com o endereço (com usuário:senha) no corpo: falha que o painel não reconhece
  server = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`erro interno em ${req.url}`);
  });
  const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const ultima = () => chamadas.at(-1)!.args;

describe("argv do ls-remote", () => {
  it("o teste de acesso usa --symref; o alerta de atualização não", async () => {
    await checkGitAccess({ source: `${base}/r.git`, branch: null, credential: null, timeoutMs: 5_000 });
    expect(ultima()).toContain("--symref");
    await remoteBranchCommit({ source: `${base}/r.git`, branch: "main", credential: null, timeoutMs: 5_000 });
    expect(ultima()).not.toContain("--symref");
  });

  it("o endereço vem logo depois de '--' (nunca lido como opção)", async () => {
    for (const run of [
      () => checkGitAccess({ source: `${base}/r.git`, branch: null, credential: null, timeoutMs: 5_000 }),
      () => remoteBranchCommit({ source: `${base}/r.git`, branch: "main", credential: null, timeoutMs: 5_000 }),
    ]) {
      await run();
      const args = ultima();
      const i = args.indexOf("--");
      expect(i).toBeGreaterThan(0);
      expect(args[i + 1]).toBe(`${base}/r.git`);
      expect(args.slice(0, i)).not.toContain(`${base}/r.git`);
    }
  });

  it("o alerta consulta SÓ a branch pedida", async () => {
    await remoteBranchCommit({ source: `${base}/r.git`, branch: "sandbox", credential: null, timeoutMs: 5_000 });
    const args = ultima();
    expect(args.slice(args.indexOf("--") + 2)).toEqual(["refs/heads/sandbox"]);
  });

  it("com credencial: o helper herdado é zerado ANTES do helper do painel e o token não vai no argv", async () => {
    await remoteBranchCommit({ source: `${base}/r.git`, branch: "main", credential: cred, timeoutMs: 5_000 });
    const args = ultima();
    const zerar = args.indexOf("credential.helper=");
    const nosso = args.findIndex((a) => a.startsWith("credential.helper=!"));
    expect(zerar).toBeGreaterThanOrEqual(0);
    expect(nosso).toBeGreaterThan(zerar);
    expect(args.join(" ")).not.toContain(TOKEN);
  });

  it("proxy sempre vazio e sem seguir redirecionamento", async () => {
    await remoteBranchCommit({ source: `${base}/r.git`, branch: "main", credential: null, timeoutMs: 5_000 });
    const args = ultima();
    expect(args).toContain("http.proxy=");
    expect(args).toContain("http.followRedirects=false");
  });
});

describe("detalhe de falha desconhecida", () => {
  it("sanitizeDetail tira usuário:senha da URL, o token solto e limita o tamanho", () => {
    const bruto = `fatal: unable to access 'https://usuario:${TOKEN}@host.example.com/r.git/': falha estranha ${TOKEN}\n`;
    const limpo = sanitizeDetail(bruto, TOKEN);
    expect(limpo).not.toContain(TOKEN);
    expect(limpo).not.toContain("usuario:");
    expect(limpo).toContain("host.example.com");
    expect(sanitizeDetail("x".repeat(500), null)).toHaveLength(200);
  });

  it("falha que ecoa o token: o detalhe devolvido sai limpo", async () => {
    const r = await checkGitAccess({ source: "https://eco-do-token.example.com/r.git", branch: null, credential: cred, timeoutMs: 5_000 });
    expect(r).toMatchObject({ ok: false, reason: "unknown" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("u:");
    expect(r.ok === false && r.detail).toContain("credencial oculta");
  });

  it("falha desconhecida do servidor: o detalhe chega sem o token e sem usuário:senha", async () => {
    const r = await checkGitAccess({
      source: `http://usuario:${TOKEN}@${base.replace("http://", "")}/r.git`,
      branch: null,
      credential: null,
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.detail).toBeTruthy();
      expect(r.detail).not.toContain(TOKEN);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});
