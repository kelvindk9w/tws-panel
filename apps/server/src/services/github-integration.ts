/**
 * github-integration.ts — "Conectar minha conta do GitHub".
 *
 * A pessoa conecta a conta UMA vez (token do GitHub, somente leitura) e
 * escolhe o repositório numa lista, em vez de colar a URL de cada um. O token
 * fica no mesmo cofre cifrado das credenciais dos projetos (chave própria,
 * INTEGRATION_KEY) e serve de credencial de clone para qualquer repositório
 * do github.com que não tenha um token próprio cadastrado.
 *
 * Regra inegociável do produto: o painel só LÊ repositórios. Token clássico
 * declara as permissões no cabeçalho x-oauth-scopes — com permissão de escrita
 * ele é recusado. O token fine-grained não declara: o guia pede "Contents:
 * Read-only", e o painel nunca faz nada além de listar e clonar.
 */
import type { GitReadCredential } from "@paas/core";
import type { CredentialVault } from "./credential-vault.js";
import { httpError } from "./http-error.js";

const INTEGRATION_KEY = "integration:github";
const API = "https://api.github.com";
/** Permissões de token clássico que dão escrita (ou mais) — recusadas. */
const WRITE_SCOPES = /(^|,)\s*(repo|public_repo|workflow|delete_repo|write:[\w:]+|admin:[\w:]+)\s*(,|$)/;
const MAX_PAGES = 5; // até 500 repositórios

export interface GithubStatus {
  connected: boolean;
  login: string | null;
  /** Últimos 4 caracteres do token (dica de conferência). */
  hint: string | null;
  updatedAt: string | null;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

interface ApiRepo {
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

/** true só para https://github.com/... (não para github.com.algum-outro-dominio). */
function isGithubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export type RepoVisibility = "public" | "private" | "unknown";
const VISIBILITY_TTL_MS = 10 * 60_000;

/** "dono/repo" de uma URL https do github.com, ou null. */
function githubPath(url: string): string | null {
  if (!isGithubUrl(url)) return null;
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(new URL(url).pathname);
  return m ? `${m[1]}/${m[2]}` : null;
}

export class GithubIntegration {
  private readonly visibilityCache = new Map<string, { value: RepoVisibility; expires: number }>();

  constructor(
    private readonly vault: CredentialVault,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private request(path: string, token: string): Promise<Response> {
    return this.fetchImpl(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tws-panel",
      },
    });
  }

  async status(): Promise<GithubStatus> {
    const info = await this.vault.info(INTEGRATION_KEY);
    return { connected: info.configured, login: info.username, hint: info.hint, updatedAt: info.updatedAt };
  }

  async token(): Promise<string | null> {
    return (await this.vault.get(INTEGRATION_KEY))?.token ?? null;
  }

  /** Confere o token no GitHub e guarda (cifrado). */
  async connect(rawToken: string): Promise<GithubStatus> {
    const token = rawToken.trim();
    if (!token) throw httpError(400, "invalid_github_token", "Cole o token do GitHub.");
    let res: Response;
    try {
      res = await this.request("/user", token);
    } catch {
      throw httpError(502, "github_unreachable", "Não foi possível falar com o GitHub agora. Tente de novo em instantes.");
    }
    if (res.status === 401) {
      throw httpError(400, "invalid_github_token", "O GitHub recusou o token: confira se copiou inteiro e se ele não expirou.");
    }
    if (!res.ok) {
      throw httpError(502, "github_error", `O GitHub respondeu com erro ${res.status}. Tente de novo em instantes.`);
    }
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes && WRITE_SCOPES.test(scopes)) {
      throw httpError(
        400,
        "github_token_can_write",
        "Este token dá permissão de ESCRITA nos repositórios (" +
          scopes +
          "). O painel só lê código: crie um token fine-grained com \"Contents: Read-only\" — o guia mostra como.",
      );
    }
    const user = (await res.json()) as { login?: string };
    if (!user.login) throw httpError(502, "github_error", "Resposta inesperada do GitHub.");
    await this.vault.set(INTEGRATION_KEY, { username: user.login, token });
    return this.status();
  }

  async disconnect(): Promise<void> {
    await this.vault.remove(INTEGRATION_KEY);
  }

  /** Repositórios que o token enxerga, mais recentes primeiro. */
  async repos(): Promise<GithubRepo[]> {
    const token = await this.token();
    if (!token) {
      throw httpError(409, "github_not_connected", "Conecte a sua conta do GitHub em Configurações → Integrações.");
    }
    const all: GithubRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await this.request(`/user/repos?per_page=100&sort=updated&page=${page}`, token);
      if (res.status === 401) {
        throw httpError(409, "github_token_expired", "O GitHub recusou o token conectado (expirou?). Conecte a conta de novo.");
      }
      if (!res.ok) throw httpError(502, "github_error", `O GitHub respondeu com erro ${res.status}.`);
      const batch = (await res.json()) as ApiRepo[];
      all.push(
        ...batch.map((r) => ({
          fullName: r.full_name,
          private: r.private,
          cloneUrl: r.clone_url,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          description: r.description,
          updatedAt: r.updated_at,
        })),
      );
      if (batch.length < 100) break;
    }
    return all;
  }

  /**
   * O repositório é público? Consulta SEM token (não depende da conta
   * conectada). 404 = privado ou inexistente; outro provedor = "unknown".
   */
  async repoVisibility(url: string): Promise<RepoVisibility> {
    const repo = githubPath(url);
    if (!repo) return "unknown";
    const cached = this.visibilityCache.get(repo);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value: RepoVisibility = "unknown";
    try {
      const res = await this.fetchImpl(`${API}/repos/${repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "tws-panel" },
      });
      if (res.status === 404) value = "private";
      else if (res.ok) value = ((await res.json()) as { private?: boolean }).private === false ? "public" : "private";
    } catch {
      value = "unknown";
    }
    this.visibilityCache.set(repo, { value, expires: Date.now() + VISIBILITY_TTL_MS });
    return value;
  }

  /** Credencial de clone para uma URL do github.com (null para outros provedores). */
  async credentialForUrl(url: string): Promise<GitReadCredential | null> {
    if (!isGithubUrl(url)) return null;
    return this.vault.get(INTEGRATION_KEY);
  }
}
