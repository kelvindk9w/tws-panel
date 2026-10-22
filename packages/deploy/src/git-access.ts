/**
 * git-access.ts — "Testar acesso" do assistente Novo projeto.
 *
 * Uma consulta SOMENTE LEITURA (`git ls-remote`) ao repositório, com o token
 * que a pessoa digitou (ou o da conta do GitHub), para dizer ANTES de criar o
 * projeto se o painel conseguirá clonar. Nada é clonado, gravado nem guardado.
 *
 * O token chega ao git só por variável de ambiente, lida por um credential
 * helper EM LINHA (git-safe.ts, o mesmo do clone): nenhum arquivo é criado e
 * o argv traz o nome das variáveis, nunca o valor — o `ps` do host não o vê.
 * Nada que vem do git é devolvido cru: o resultado é um motivo (código) mais
 * uma mensagem fixa; só o motivo "unknown" leva uma linha do git, antes
 * limpa do token e das credenciais da URL.
 *
 * A validação do endereço e da branch (validateGitSource/validateBranch) é
 * feita por quem chama (DeployService); aqui há só a defesa mínima de nunca
 * entregar ao git um valor que ele leria como opção.
 */
import { tmpdir } from "node:os";
import type { GitAccessCheckResponse, GitAccessFailureReason, GitReadCredential } from "@paas/core";
import { run } from "./exec.js";
import { CREDENTIAL_HELPER, GIT_SAFE_CONFIG, gitSafeEnv } from "./git-safe.js";

export const GIT_ACCESS_TIMEOUT_MS = 15_000;
const MAX_BRANCHES = 10;
const CREDENCIAL_OCULTA = "«credencial oculta»";

export const GIT_ACCESS_MESSAGES: Record<GitAccessFailureReason, string> = {
  invalid_source: "Endereço do repositório inválido. Use uma URL https://, ssh:// ou git@host:caminho.",
  invalid_branch: "Nome de branch inválido.",
  invalid_token:
    "O servidor do repositório recusou o token: ele está errado, incompleto ou expirou. Gere outro e cole inteiro.",
  auth_required:
    "O repositório pede autenticação e nenhum token foi informado. Se ele é privado, cole um token de leitura.",
  no_permission:
    "O token foi aceito, mas não tem permissão de leitura neste repositório. No GitHub, use um fine-grained token com " +
    "\"Contents: Read\" incluindo este repositório (ou um token clássico com o escopo de leitura).",
  not_found: "Repositório não encontrado. Confira o endereço (dono/nome) e se ele existe.",
  not_found_or_no_access:
    "Repositório não encontrado. Ou o endereço está errado, ou o token não enxerga este repositório (o GitHub responde " +
    "igual nos dois casos). Confira o endereço e se o token inclui este repositório.",
  branch_not_found: "O repositório está acessível, mas essa branch não existe.",
  unsupported_host: "Este endereço usa um protocolo que o painel não suporta. Use https:// ou ssh.",
  unreachable:
    "Não foi possível falar com o servidor do repositório (endereço, rede ou certificado). Confira o endereço e se o servidor está no ar.",
  timeout: "O servidor do repositório demorou demais para responder (tempo esgotado). Tente de novo em instantes.",
  token_not_applicable: "O token só vale para endereços https://. Para ssh, o painel usa a chave SSH, não um token.",
  account_not_connected: "Nenhuma conta do GitHub está conectada. Conecte em Configurações → Integrações.",
  account_not_applicable: "A conta do GitHub conectada só vale para repositórios do github.com.",
  unknown: "O teste falhou por um motivo que o painel não reconheceu.",
};

/** Traduz a saída de erro do git em um motivo. A ordem importa: o mais específico primeiro. */
export function classifyGitFailure(output: string, hasCredential: boolean): GitAccessFailureReason {
  const o = output.toLowerCase();
  if (/encerrado pelo sinal|timed out|timeout was reached|operation too slow|less than \d+ bytes\/sec/.test(o)) return "timeout";
  if (/transport '.*' not allowed|unable to find remote helper|protocol .* is not supported/.test(o)) {
    return "unsupported_host";
  }
  if (
    /could not resolve|couldn't resolve|failed to connect|couldn't connect|connection refused|connection reset|network is unreachable|no route to host|ssl certificate|ssl connect|certificate problem|host key verification failed|empty reply|recv failure/.test(
      o,
    )
  ) {
    return "unreachable";
  }
  if (/returned error: 403|permission to .* denied|permission denied|not allowed to download|forbidden|access denied to|insufficient/.test(o)) {
    return "no_permission";
  }
  if (/authentication failed|invalid username or (token|password)|http basic: access denied|returned error: 401|bad credentials/.test(o)) {
    return hasCredential ? "invalid_token" : "auth_required";
  }
  if (/could not read (username|password)|terminal prompts disabled/.test(o)) {
    return hasCredential ? "invalid_token" : "auth_required";
  }
  if (/repository .*not found|returned error: 404|does not appear to be a git repository|does not exist|not found/.test(o)) {
    return hasCredential ? "not_found_or_no_access" : "not_found";
  }
  return "unknown";
}

/** Última linha útil do git, sem o token e sem usuário:senha da URL. */
export function sanitizeDetail(output: string, token: string | null): string {
  // primeiro o usuário:senha da URL (o token pode estar nele), depois o token solto
  let text = output.replace(/(\/\/)[^/@\s]+@/g, "$1");
  if (token) text = text.split(token).join(CREDENCIAL_OCULTA);
  const last = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return (last ?? "").slice(0, 200);
}

export interface GitAccessInput {
  source: string;
  /** Branch a conferir (null = só listar). */
  branch: string | null;
  credential: GitReadCredential | null;
  timeoutMs?: number;
  maxBranches?: number;
}

function falha(
  reason: GitAccessFailureReason,
  extra: { defaultBranch?: string | null; branches?: string[]; totalBranches?: number; detail?: string } = {},
): GitAccessCheckResponse {
  return { ok: false, reason, message: GIT_ACCESS_MESSAGES[reason], ...extra };
}

/** Lê a saída de `ls-remote --symref`: branches e a branch padrão. */
export function parseHeads(stdout: string): { branches: string[]; defaultBranch: string | null } {
  const heads = new Map<string, string>();
  let headSha: string | null = null;
  let symref: string | null = null;
  for (const line of stdout.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) {
      symref = sym[1] ?? null;
      continue;
    }
    const m = /^([0-9a-f]{40,64})\t(\S+)$/.exec(line);
    if (!m) continue;
    if (m[2] === "HEAD") headSha = m[1] ?? null;
    else if (m[2]?.startsWith("refs/heads/")) heads.set(m[2].slice("refs/heads/".length), m[1] ?? "");
  }
  const names = [...heads.keys()];
  let defaultBranch = symref && heads.has(symref) ? symref : null;
  if (!defaultBranch && headSha) {
    const same = names.filter((n) => heads.get(n) === headSha);
    defaultBranch = same.find((n) => n === "main") ?? same.find((n) => n === "master") ?? same[0] ?? null;
  }
  const ordered = defaultBranch ? [defaultBranch, ...names.filter((n) => n !== defaultBranch)] : names;
  return { branches: ordered, defaultBranch };
}

export async function checkGitAccess(input: GitAccessInput): Promise<GitAccessCheckResponse> {
  const { source, branch, credential } = input;
  if (source.startsWith("-")) return falha("invalid_source");
  const isHttp = /^https?:\/\//i.test(source);
  if (credential && !isHttp) return falha("token_not_applicable");

  const baseEnv = gitSafeEnv(process.env);
  const env: NodeJS.ProcessEnv = credential
    ? { ...baseEnv, PAAS_GIT_USERNAME: credential.username, PAAS_GIT_PASSWORD: credential.token }
    : baseEnv;
  // sem tty o ssh já não pergunta nada; BatchMode deixa isso explícito e a falha, imediata
  if (!isHttp) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10";

  const args = [
    ...GIT_SAFE_CONFIG,
    ...(credential ? ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`] : []),
    // servidor que para de responder derruba a conexão em vez de pendurar o teste
    "-c",
    "http.lowSpeedLimit=1000",
    "-c",
    "http.lowSpeedTime=10",
    "ls-remote",
    "--symref",
    "--",
    source,
    "HEAD",
    "refs/heads/*",
  ];
  const result = await run("git", args, { env, cwd: tmpdir(), timeoutMs: input.timeoutMs ?? GIT_ACCESS_TIMEOUT_MS });
  const token = credential?.token ?? null;

  if (result.code !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    const reason = classifyGitFailure(output, credential !== null);
    return falha(reason, reason === "unknown" ? { detail: sanitizeDetail(output, token) } : {});
  }

  const { branches, defaultBranch } = parseHeads(result.stdout);
  const shown = branches.slice(0, input.maxBranches ?? MAX_BRANCHES);
  if (branch && !branches.includes(branch)) {
    return falha("branch_not_found", { defaultBranch, branches: shown, totalBranches: branches.length });
  }
  const suffix = defaultBranch ? ` Branch padrão: ${defaultBranch}.` : " O repositório está vazio (nenhuma branch ainda).";
  return {
    ok: true,
    defaultBranch,
    branches: shown,
    totalBranches: branches.length,
    branchFound: branch ? true : null,
    message: `Acesso confirmado: o painel consegue ler este repositório.${suffix}`,
  };
}
