/**
 * Quais variáveis OBRIGATÓRIAS do compose o e-mail do projeto pode preencher,
 * e em que pé cada uma está. Só lógica (sem tela): o aviso da seção Variáveis
 * (ProjectEnvCard) mostra o resultado.
 *
 * Três tipos de nome:
 *  - direto: um dos valores que o painel já entrega com o nome padrão
 *    (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME);
 *  - apelido: nome comum de outro app (SMTP_PASSWORD, SMTP_FROM…) que dá para
 *    LIGAR a um desses valores — o painel guarda só a ligação;
 *  - manual: o e-mail não fornece (SMTP_SECURE…); o painel só orienta.
 */
import {
  MAX_PROJECT_EMAIL_LINKS,
  PROJECT_EMAIL_VALUE_KEYS,
  type ComposeVariable,
  type ProjectEmailConfig,
  type ProjectEmailValueKey,
} from "@paas/core";

const ALIASES: Record<ProjectEmailValueKey, string[]> = {
  SMTP_HOST: ["MAIL_HOST", "EMAIL_HOST", "SMTP_SERVER", "MAIL_SERVER", "SMTP_ADDRESS"],
  SMTP_PORT: ["MAIL_PORT", "EMAIL_PORT"],
  SMTP_USER: ["SMTP_USERNAME", "MAIL_USER", "MAIL_USERNAME", "EMAIL_USER", "EMAIL_HOST_USER"],
  SMTP_PASS: ["SMTP_PASSWORD", "SMTP_PWD", "MAIL_PASS", "MAIL_PASSWORD", "EMAIL_PASSWORD", "EMAIL_HOST_PASSWORD"],
  MAIL_FROM: [
    "SMTP_FROM",
    "EMAIL_FROM",
    "SMTP_FROM_ADDRESS",
    "MAIL_FROM_ADDRESS",
    "EMAIL_FROM_ADDRESS",
    "FROM_EMAIL",
    "MAIL_SENDER",
  ],
  MAIL_FROM_NAME: ["SMTP_FROM_NAME", "EMAIL_FROM_NAME", "MAIL_SENDER_NAME", "FROM_NAME"],
};

const ALIAS_SOURCE = new Map<string, ProjectEmailValueKey>(
  (Object.entries(ALIASES) as [ProjectEmailValueKey, string[]][]).flatMap(([source, names]) =>
    names.map((n) => [n, source] as const),
  ),
);

/**
 * Nomes de configuração de TLS que o e-mail não fornece. `value`: o que
 * combina com o que o painel entrega (porta 587, STARTTLS); sem `value`, o
 * painel só avisa que é manual (não adivinha o que o app espera).
 */
const MANUAL: Record<string, { value?: string }> = {
  SMTP_SECURE: { value: "false" },
  MAIL_SECURE: { value: "false" },
  SMTP_REQUIRE_TLS: {},
  SMTP_IGNORE_TLS: {},
  SMTP_STARTTLS: {},
  SMTP_TLS: {},
  MAIL_ENCRYPTION: {},
};

export type EmailVariableKind = "direct" | "alias" | "manual";

export function classifyEmailVariable(
  name: string,
): { kind: EmailVariableKind; source?: ProjectEmailValueKey; value?: string } | null {
  if ((PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(name)) {
    return { kind: "direct", source: name as ProjectEmailValueKey };
  }
  const source = ALIAS_SOURCE.get(name);
  if (source) return { kind: "alias", source };
  const manual = MANUAL[name];
  if (manual) return { kind: "manual", ...(manual.value !== undefined ? { value: manual.value } : {}) };
  return null;
}

export type EmailItemState =
  | "provided" // o e-mail entrega com o nome padrão
  | "linked" // ligada a um valor do e-mail
  | "suggest" // e-mail ligado; dá para ligar o nome (sugestão)
  | "off" // e-mail desligado; ele poderia fornecer
  | "manual-missing" // manual e sem valor
  | "set" // preenchida nas Variáveis, sem conflito
  | "unavailable" // o e-mail está ligado mas não entrega este valor agora
  | "unknown"; // não deu para consultar o e-mail

export interface EmailAdviceItem {
  name: string;
  kind: EmailVariableKind;
  source?: ProjectEmailValueKey;
  /** Valor típico para o que o painel entrega (manual). */
  value?: string;
  state: EmailItemState;
  /** Há valor digitado nas Variáveis que colide com o do e-mail. */
  collision: boolean;
}

export interface EmailAdvice {
  /** Mostra o aviso: há algo a fazer ou uma colisão a avisar. */
  show: boolean;
  /** Estado do e-mail: null = não deu para consultar. */
  enabled: boolean | null;
  items: EmailAdviceItem[];
  /** Sugestões de ligação possíveis (vazia se não couberem no limite). */
  suggestions: { name: string; source: ProjectEmailValueKey }[];
  /** Há sugestões, mas não cabem no limite de ligações. */
  overLimit: boolean;
}

/**
 * `filled`: nomes com valor na tela (Variáveis). `provided`: o que o painel
 * entrega no deploy (e-mail e ligações). `email`: a configuração do
 * e-mail do projeto (null = não deu para consultar). `links`: ligações atuais.
 */
export function emailAdvice(
  compose: ComposeVariable[] | null,
  filled: ReadonlySet<string>,
  provided: ReadonlySet<string>,
  email: ProjectEmailConfig | null,
  links: Record<string, ProjectEmailValueKey>,
): EmailAdvice {
  const items: EmailAdviceItem[] = [];
  const enabled = email === null ? null : email.enabled;
  for (const cv of compose ?? []) {
    if (!cv.required) continue;
    if ((cv.alternatives ?? []).some((a) => filled.has(a))) continue;
    const c = classifyEmailVariable(cv.name);
    if (!c) continue;
    const has = filled.has(cv.name);
    // o deploy entrega o valor padrão (inclusive MAIL_FROM_NAME, que cai no nome do projeto);
    // caixa adotada com senha desconhecida não entrega nada
    const delivered = c.source !== undefined && provided.has(c.source);
    const alreadyLinked = email?.envLinks?.[cv.name] !== undefined;
    const base = {
      name: cv.name,
      kind: c.kind,
      ...(c.source ? { source: c.source } : {}),
      ...(c.value ? { value: c.value } : {}),
    };
    const linkedTo = links[cv.name];
    if (c.kind === "manual") {
      items.push({ ...base, state: has ? "set" : "manual-missing", collision: false });
    } else if (provided.has(cv.name)) {
      // o painel entrega no deploy; valor digitado aqui colide (direto: o das Variáveis vence; ligada: a ligação vence)
      items.push({
        ...base,
        ...(linkedTo ? { source: linkedTo } : {}),
        state: linkedTo ? "linked" : "provided",
        collision: has,
      });
    } else if (enabled === true) {
      if (has || c.kind === "direct") {
        items.push({ ...base, state: has ? "set" : "unavailable", collision: false });
      } else {
        // nome já ligado (mesmo que o valor não chegue agora) não ganha sugestão
        items.push({ ...base, state: delivered && !alreadyLinked ? "suggest" : "unavailable", collision: false });
      }
    } else {
      items.push({ ...base, state: has ? "set" : enabled === false ? "off" : "unknown", collision: false });
    }
  }
  const suggestions = items.flatMap((i) =>
    i.state === "suggest" && i.source ? [{ name: i.name, source: i.source }] : [],
  );
  const overLimit = Object.keys(email?.envLinks ?? links).length + suggestions.length > MAX_PROJECT_EMAIL_LINKS;
  const show = items.some(
    (i) => ["suggest", "off", "manual-missing", "unavailable", "unknown"].includes(i.state) || i.collision,
  );
  return { show, enabled, items, suggestions: overLimit ? [] : suggestions, overLimit };
}
