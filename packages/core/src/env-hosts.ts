/**
 * env-hosts.ts — aviso de valor estranho em variável de HOST.
 *
 * Caso real: SITE_HOST=http://site… e PAGAMENTOS_HOST=https://pagamentos… salvos nas
 * Variáveis do projeto. O compose do projeto esperava só o nome do host; o
 * Caddy do projeto montou "http://http://…" e a tela ficou em branco, sem
 * nenhuma pista. O painel agora avisa (nunca bloqueia: o valor pode ser
 * proposital) no formulário, na importação de .env e no log do deploy.
 *
 * REGRA (pequena de propósito, para não gerar falso positivo):
 *  - o NOME termina em HOST, HOSTNAME ou DOMAIN (com ou sem prefixo, qualquer
 *    caixa): SITE_HOST, PAGAMENTOS_HOSTNAME, APP_DOMAIN, HOST. Variáveis *_URL*
 *    nunca entram. DOCKER_HOST fica de fora (o esquema unix:// / tcp:// faz
 *    parte do valor dele).
 *  - o VALOR é estranho quando tem esquema (`://`), barra/caminho/consulta,
 *    porta (`host:587` ou `[::1]:25`) ou espaço. Porta conta: a convenção é
 *    a porta ir em *_PORT; se o app lê `host:porta` de propósito, o aviso
 *    pode ser ignorado.
 *  - não avisa: valor vazio, socket unix (começa com `/`), interpolação
 *    (`${…}`), lista separada por vírgula e IPv6 sem colchetes (`::1`).
 *
 * SEGREDO: nome com cara de segredo (isSecretVariableName) e valor com
 * usuário:senha na frente nunca têm o valor, nem a sugestão, impressos.
 */

export type HostValueProblem = "scheme" | "path" | "port" | "space";

export interface HostValueCheck {
  problems: HostValueProblem[];
  /** Só o nome do host (sem esquema, credenciais, caminho nem porta); null se não sobra nada. */
  suggestion: string | null;
  /** O valor tinha `usuario:senha@` na frente: a sugestão não deve ser exibida junto de segredo. */
  hasCredentials: boolean;
}

const HOST_NAME = /(^|_)(HOST|HOSTNAME|DOMAIN)$/i;
const HOST_NAME_EXCEPTIONS = new Set(["DOCKER_HOST"]);

/** Nome com cara de segredo: o valor nunca entra em pesquisa nem em log. */
const SECRET_NAME = /PASS|SENHA|SECRET|TOKEN|KEY|CHAVE|PRIVATE|CREDENTIAL|AUTH|CERT/i;

export function isSecretVariableName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function isHostVariableName(name: string): boolean {
  const n = name.trim();
  return HOST_NAME.test(n) && !HOST_NAME_EXCEPTIONS.has(n.toUpperCase());
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_PORT = /^(\[[^\]]*\]|[^:[\]\s]+):\d+$/;

/** null = nada de estranho (ou a variável não é de host). */
export function checkHostVariable(name: string, value: string): HostValueCheck | null {
  if (!isHostVariableName(name)) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("$") || trimmed.includes(",") || trimmed.startsWith("/")) return null;

  const scheme = SCHEME.exec(trimmed);
  const rest = scheme ? trimmed.slice(scheme[0].length) : trimmed;
  const cut = rest.search(/[/?#]/);
  const authority = cut >= 0 ? rest.slice(0, cut) : rest;
  const at = authority.lastIndexOf("@");
  const hostPort = authority.slice(at + 1).split(/\s/)[0] ?? "";
  const port = HOST_PORT.exec(hostPort);

  const problems: HostValueProblem[] = [];
  if (scheme) problems.push("scheme");
  if (cut >= 0) problems.push("path");
  if (port) problems.push("port");
  if (value !== trimmed || /\s/.test(trimmed)) problems.push("space");
  if (problems.length === 0) return null;

  const host = port ? port[1] : hostPort;
  return { problems, suggestion: host ? host : null, hasCredentials: at >= 0 };
}

const PROBLEM_TEXT: Record<HostValueProblem, string> = {
  scheme: "esquema (http:// ou https://)",
  path: "barra ou caminho",
  port: "porta",
  space: "espaço",
};

/**
 * Linhas de aviso para o log do deploy, uma por variável de host estranha.
 * Nunca traz o valor salvo; a sugestão (só o host) some quando o nome parece
 * segredo ou o valor tinha credenciais.
 */
export function hostVariableLogLines(vars: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const check = checkHostVariable(name, value);
    if (!check) continue;
    const hide = check.hasCredentials || isSecretVariableName(name);
    const suggestion = check.suggestion && !hide ? ` (sugestão: ${check.suggestion})` : "";
    const found = check.problems.map((p) => PROBLEM_TEXT[p]).join(", ");
    lines.push(
      `⚠ Aviso: a variável ${name} tem ${found} no valor. Variáveis de host costumam esperar só o nome do host${suggestion}; ` +
        `com isso o projeto pode abrir em branco. O deploy segue com o valor salvo — corrija em Variáveis se não for proposital.\n`,
    );
  }
  return lines;
}
