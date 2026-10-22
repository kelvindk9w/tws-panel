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
 * PRAZO E PROCESSOS: o git roda em um grupo de processos próprio (`detached`)
 * e, no prazo (15 s no total, mesmo com o servidor gotejando bytes) ou ao fim
 * normal, o GRUPO inteiro recebe SIGKILL: nenhum `git remote-http`/`ssh` fica
 * vivo. Enquanto o git roda, o token está no AMBIENTE dele (legível em
 * /proc/<pid>/environ pelo mesmo usuário do sistema), nunca no argv.
 *
 * REDIRECIONAMENTO: com token, `http.followRedirects=false`: um 301/302 não leva o
 * cabeçalho Authorization a outro host. Sem token o redirecionamento segue.
 * PROXY: variáveis de proxy herdadas são removidas e `http.proxy` fica vazio, para
 * a consulta ir direto ao endereço conferido (um proxy contornaria a fixação do DNS).
 *
 * DESTINOS: resolveTarget recusa loopback, 0.0.0.0, link-local (inclui os
 * metadados da nuvem, 169.254.0.0/16) e nomes que resolvam para eles; os
 * endereços resolvidos são fixados no curl (http.curloptResolve) para um DNS
 * que muda entre a conferência e a consulta (rebinding) não furar a regra.
 * Redes privadas (10/8, 172.16/12, 192.168/16) seguem permitidas: há Git
 * interno legítimo. Limitações: em ssh a conferência é só do nome resolvido
 * (o ssh resolve de novo); e, em redes privadas, a rota ainda é um oráculo
 * (a resposta distingue inacessível, tempo esgotado, não encontrado…), limitado
 * a 10 consultas por minuto e a quem tem sessão no painel.
 *
 * A validação do endereço e da branch (validateGitSource/validateBranch) é
 * feita por quem chama (DeployService); aqui há só a defesa mínima de nunca
 * entregar ao git um valor que ele leria como opção.
 */
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import type { GitAccessCheckResponse, GitAccessFailureReason, GitReadCredential } from "@paas/core";
import { GIT_SAFE_CONFIG, NO_REDIRECT_CONFIG, gitSafeEnv } from "./git-safe.js";

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
  redirected:
    "O endereço redireciona para outro lugar (falta o \".git\" no fim, como no GitLab, ou o repositório foi renomeado ou movido). Por segurança o painel não segue redirecionamentos com token: use o endereço final, por exemplo com \".git\".",
  blocked_host:
    "Este endereço aponta para a própria máquina ou para a rede de metadados (loopback ou link-local). O teste de acesso não consulta esses destinos.",
  token_not_applicable: "O token só vale para endereços https://. Para ssh, o painel usa a chave SSH, não um token.",
  account_not_connected: "Nenhuma conta do GitHub está conectada. Conecte em Configurações → Integrações.",
  account_not_applicable: "A conta do GitHub conectada só vale para repositórios do github.com.",
  unknown: "O teste falhou por um motivo que o painel não reconheceu.",
};

/** Traduz a saída de erro do git em um motivo. A ordem importa: o mais específico primeiro. */
export function classifyGitFailure(output: string, hasCredential: boolean): GitAccessFailureReason {
  const o = output.toLowerCase();
  if (/encerrado pelo sinal|timed out|timeout was reached|operation too slow|less than \d+ bytes\/sec/.test(o)) return "timeout";
  if (/redirecting to|unable to update url base from redirection|returned error: 30[1278]/.test(o)) return "redirected";
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
  /** Endereços já conferidos por resolveTarget (host:porta:ip), fixados no curl contra rebinding. */
  pin?: string | null;
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

const MAX_OUTPUT = 1024 * 1024;
/** Marcador que o helper de credencial escreve no stderr quando o git de fato pede a credencial. */
const CREDENTIAL_USED_MARK = "paas-credential-used";
/** Como o helper do clone, mas avisa quando foi chamado (o git só pede token se o servidor exigir). */
const CHECK_CREDENTIAL_HELPER =
  `!f() { test "$1" = get && echo ${CREDENTIAL_USED_MARK} >&2 && ` +
  `printf 'username=%s\\npassword=%s\\n' "$PAAS_GIT_USERNAME" "$PAAS_GIT_PASSWORD"; }; f`;

interface GroupedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Roda o git em um grupo de processos próprio e mata o grupo inteiro no prazo
 * total e ao terminar. `execFile` só mata o processo de cima: os filhos
 * (remote-http, ssh) continuariam vivos, com o token no ambiente.
 */
function runGrouped(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<GroupedResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { env, cwd: tmpdir(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // o grupo já acabou
      }
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `Falha ao executar o git: ${err.message}`;
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
}

export type DnsLookup = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: DnsLookup = (host) => dnsLookup(host, { all: true });

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

/** Loopback, 0.0.0.0/8, link-local (IPv4 169.254/16, IPv6 fe80::/10) e ::; IPv4 embutido em IPv6 também. */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = ipv4Parts(ip);
  if (v4) return v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254);
  if (ip === "::" || ip === "::1") return true;
  if (/^fe[89ab]/.test(ip)) return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return isBlockedAddress(dotted[1] as string);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1] as string, 16);
    const lo = parseInt(hex[2] as string, 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

export type TargetCheck =
  | { ok: true; pin: string | null }
  | { ok: false; reason: "blocked_host" | "unreachable" | "invalid_source" };

/**
 * Confere o destino ANTES de consultar: recusa máquina local e metadados,
 * resolve o nome (todos os endereços precisam ser permitidos) e devolve o
 * `pin` host:porta:endereços para o curl usar exatamente o que foi conferido.
 */
export async function resolveTarget(source: string, lookup: DnsLookup = defaultLookup): Promise<TargetCheck> {
  let host: string;
  let port: string | null = null;
  let isUrl = false;
  const scheme = /^(https?|ssh):\/\//i.exec(source);
  if (scheme) {
    isUrl = true;
    try {
      const u = new URL(source);
      host = u.hostname.replace(/^\[|\]$/g, "");
      port = u.port || (scheme[1]?.toLowerCase() === "https" ? "443" : scheme[1]?.toLowerCase() === "http" ? "80" : null);
    } catch {
      return { ok: false, reason: "invalid_source" };
    }
  } else {
    const scp = /^[^@\s]+@([^:\s]+):/.exec(source);
    if (!scp) return { ok: false, reason: "invalid_source" };
    host = scp[1] as string;
  }
  if (!host) return { ok: false, reason: "invalid_source" };
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return { ok: false, reason: "blocked_host" };
  if (isIP(host)) return isBlockedAddress(host) ? { ok: false, reason: "blocked_host" } : { ok: true, pin: null };

  let found: { address: string; family: number }[];
  try {
    found = await lookup(host);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (found.length === 0) return { ok: false, reason: "unreachable" };
  if (found.some((f) => isBlockedAddress(f.address))) return { ok: false, reason: "blocked_host" };
  const web = isUrl && !/^ssh:/i.test(source);
  if (!web || !port) return { ok: true, pin: null };
  const addrs = found.map((f) => (f.family === 6 ? `[${f.address}]` : f.address)).join(",");
  return { ok: true, pin: `${host}:${port}:${addrs}` };
}

export async function checkGitAccess(input: GitAccessInput): Promise<GitAccessCheckResponse> {
  const { source, branch, credential } = input;
  if (source.startsWith("-")) return falha("invalid_source");
  const isHttp = /^https?:\/\//i.test(source);
  if (credential && !isHttp) return falha("token_not_applicable");

  const baseEnv = gitSafeEnv(process.env);
  for (const name of Object.keys(baseEnv)) {
    if (/^(https?_proxy|all_proxy)$/i.test(name)) delete baseEnv[name];
  }
  const env: NodeJS.ProcessEnv = credential
    ? { ...baseEnv, PAAS_GIT_USERNAME: credential.username, PAAS_GIT_PASSWORD: credential.token }
    : baseEnv;
  // sem tty o ssh já não pergunta nada; BatchMode deixa isso explícito e a falha, imediata
  // (a fase do banner não é coberta por ConnectTimeout: o ServerAlive derruba o ssh mudo)
  if (!isHttp) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2";
  }

  const args = [
    ...GIT_SAFE_CONFIG,
    "-c",
    "http.proxy=",
    ...(credential ? ["-c", "credential.helper=", "-c", `credential.helper=${CHECK_CREDENTIAL_HELPER}`, ...NO_REDIRECT_CONFIG] : []),
    ...(input.pin ? ["-c", `http.curloptResolve=${input.pin}`] : []),
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
  const result = await runGrouped(args, env, input.timeoutMs ?? GIT_ACCESS_TIMEOUT_MS);
  const token = credential?.token ?? null;
  const tokenUsed = credential ? result.stderr.includes(CREDENTIAL_USED_MARK) : null;
  result.stderr = result.stderr.split(CREDENTIAL_USED_MARK).join("");

  if (result.timedOut) return falha("timeout");
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
    tokenUsed,
    message: `Acesso confirmado: o painel consegue ler este repositório.${suffix}`,
  };
}
