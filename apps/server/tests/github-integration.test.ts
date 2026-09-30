/**
 * github-integration.test.ts — "Conectar minha conta do GitHub".
 *
 * Pedido do dono do produto: em vez de colar a URL de cada repositório, a
 * pessoa conecta a conta uma vez e escolhe numa lista (públicos e privados).
 * Regra inegociável: o painel só LÊ repositórios — token clássico com
 * permissão de escrita é recusado.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../src/services/credential-vault.js";
import { GithubIntegration } from "../src/services/github-integration.js";

let dataDir: string;
let vault: CredentialVault;
let fetchMock: ReturnType<typeof vi.fn>;
let gh: GithubIntegration;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const REPO = (name: string, priv: boolean, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `kelvin/${name}`,
  private: priv,
  clone_url: `https://github.com/kelvin/${name}.git`,
  html_url: `https://github.com/kelvin/${name}`,
  default_branch: "main",
  description: null,
  updated_at: "2026-09-30T10:00:00Z",
  ...extra,
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-gh-"));
  vault = new CredentialVault(dataDir);
  fetchMock = vi.fn(async (url: string) => {
    if (url === "https://api.github.com/user") return json({ login: "kelvin" });
    if (url.startsWith("https://api.github.com/user/repos")) {
      return json([REPO("site", false), REPO("api-privada", true, { default_branch: "dev", description: "API" })]);
    }
    return json({ message: "Not Found" }, 404);
  });
  gh = new GithubIntegration(vault, fetchMock as unknown as typeof fetch);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("conectar a conta do GitHub", () => {
  it("sem conexão: status desconectado", async () => {
    expect(await gh.status()).toMatchObject({ connected: false, login: null });
  });

  it("token válido: conecta, guarda cifrado e mostra só o login e a dica", async () => {
    const st = await gh.connect("github_pat_ABCDEFGH1234");
    expect(st).toMatchObject({ connected: true, login: "kelvin", hint: "1234" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer github_pat_ABCDEFGH1234" });
    const disco = await readFile(path.join(dataDir, "credentials.json"), "utf8");
    expect(disco).not.toContain("github_pat_ABCDEFGH1234");
    expect(JSON.stringify(await gh.status())).not.toContain("github_pat_ABCDEFGH1234");
  });

  it("token recusado pelo GitHub → 400 invalid_github_token, nada guardado", async () => {
    fetchMock.mockImplementationOnce(async () => json({ message: "Bad credentials" }, 401));
    await expect(gh.connect("github_pat_errado")).rejects.toMatchObject({ statusCode: 400, code: "invalid_github_token" });
    expect((await gh.status()).connected).toBe(false);
  });

  it("token clássico com permissão de escrita (repo) → recusado: o painel só lê", async () => {
    fetchMock.mockImplementationOnce(async () => json({ login: "kelvin" }, 200, { "x-oauth-scopes": "repo, read:org" }));
    await expect(gh.connect("ghp_classico")).rejects.toMatchObject({ statusCode: 400, code: "github_token_can_write" });
    expect((await gh.status()).connected).toBe(false);
  });

  it("desconectar apaga o token", async () => {
    await gh.connect("github_pat_ABCDEFGH1234");
    await gh.disconnect();
    expect((await gh.status()).connected).toBe(false);
    expect(await gh.token()).toBeNull();
  });
});

describe("repositórios da conta", () => {
  it("lista públicos e privados, com a branch padrão de cada um", async () => {
    await gh.connect("github_pat_ABCDEFGH1234");
    const repos = await gh.repos();
    expect(repos).toEqual([
      expect.objectContaining({ fullName: "kelvin/site", private: false, cloneUrl: "https://github.com/kelvin/site.git", defaultBranch: "main" }),
      expect.objectContaining({ fullName: "kelvin/api-privada", private: true, defaultBranch: "dev", description: "API" }),
    ]);
  });

  it("sem conta conectada → 409 github_not_connected", async () => {
    await expect(gh.repos()).rejects.toMatchObject({ statusCode: 409, code: "github_not_connected" });
  });
});

describe("credencial de clone", () => {
  it("URL do GitHub usa o token da conta; outro provedor não", async () => {
    await gh.connect("github_pat_ABCDEFGH1234");
    expect(await gh.credentialForUrl("https://github.com/kelvin/api-privada.git")).toMatchObject({ token: "github_pat_ABCDEFGH1234" });
    expect(await gh.credentialForUrl("https://gitlab.com/kelvin/x.git")).toBeNull();
    expect(await gh.credentialForUrl("https://github.com.evil.example/kelvin/x.git")).toBeNull();
  });
});
