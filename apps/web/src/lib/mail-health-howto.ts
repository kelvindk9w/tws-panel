/**
 * "O que fazer" de cada item da saúde do envio de e-mail: quais passos mostrar,
 * quais valores o leigo pode copiar e se o item é opcional.
 *
 * Os textos ficam nos dicionários (namespace mailHealth, "howto.*"). Aqui só
 * se decide a estrutura, a partir do que o servidor devolveu em tempo de
 * execução (plano de DNS e item verificado). Nenhum IP, domínio ou nome de
 * servidor é escrito no código: tudo vem de `plan` e `check`.
 */
import type { DnsPlanResponse, MailHealthCheck } from "@paas/core";
import type { Key } from "@/i18n/keys";

type Params = Record<string, string | number>;

export type HowtoVariant =
  | "a"
  | "mx"
  | "spf"
  | "dkim"
  | "dmarc"
  | "ptr"
  | "port25"
  | "queue"
  | "tls"
  | "dnsbl"
  | "propagation"
  | "mta_sts"
  | "tls_rpt"
  | "dmarc_next_none"
  | "dmarc_next_quarantine";

/** Quantos passos cada variante tem (howto.<variante>.1 … n). */
export const HOWTO_STEP_COUNT: Record<HowtoVariant, number> = {
  a: 4,
  mx: 4,
  spf: 3,
  dkim: 4,
  dmarc: 3,
  ptr: 5,
  port25: 4,
  queue: 3,
  tls: 3,
  dnsbl: 3,
  propagation: 2,
  mta_sts: 4,
  tls_rpt: 3,
  dmarc_next_none: 3,
  dmarc_next_quarantine: 2,
};

/** Variantes que têm texto de "o que você ganha" (howto.<variante>.gain). */
export const HOWTO_WITH_GAIN: ReadonlySet<HowtoVariant> = new Set(["mta_sts", "tls_rpt", "dmarc_next_none", "dmarc_next_quarantine"]);
/** Variantes que têm texto de risco (howto.<variante>.risk). */
export const HOWTO_WITH_RISK: ReadonlySet<HowtoVariant> = new Set(["dmarc_next_none", "dmarc_next_quarantine"]);
/** Itens opcionais: o envio funciona sem eles; o texto diz isso e o ganho. */
const OPTIONAL: ReadonlySet<HowtoVariant> = HOWTO_WITH_GAIN;
/** Opcionais que são o "próximo passo" de algo que já está em ordem. */
const NEXT_STEP: ReadonlySet<HowtoVariant> = HOWTO_WITH_RISK;

export interface HowtoCopy {
  labelKey: Key;
  /** Valor literal (vindo do plano ou do item). */
  value?: string;
  /** Ou uma mensagem do dicionário preenchida com `params` (ex.: texto para o suporte). */
  messageKey?: Key;
  params?: Params;
}

export interface Howto {
  variant: HowtoVariant;
  optional: boolean;
  nextStep: boolean;
  steps: Key[];
  gainKey?: Key;
  riskKey?: Key;
  /** Parâmetros dos textos dos passos. */
  params: Params;
  copies: HowtoCopy[];
  /** Só o PTR: explicação de por que é atenção importante e não crítico. */
  severityKey?: Key;
}

function variantOf(check: MailHealthCheck): HowtoVariant | null {
  if (check.id === "helo") return check.level === "ok" ? null : "a";
  if (check.id === "dmarc" && check.level === "ok") {
    if (check.code === "none") return "dmarc_next_none";
    if (check.code === "quarantine") return "dmarc_next_quarantine";
    return null;
  }
  if (check.level === "ok") return null;
  if (check.id === "queue" && check.code === "empty") return null;
  return check.id as HowtoVariant;
}

const k = (suffix: string): Key => `mailHealth.${suffix}` as Key;

/**
 * `ctx.hasHelo`: o relatório tem o item do nome do servidor no envio (HELO), que só
 * existe quando esse nome é outro que mail.<domínio> (por exemplo, no 2º domínio de um
 * servidor). Nesse caso o PTR esperado é o nome do HELO, e o "Registro A" a conferir é
 * o do HELO (na seção do servidor), não o A de mail.<este domínio>.
 */
export function howtoFor(check: MailHealthCheck, plan: DnsPlanResponse, ctx: { hasHelo?: boolean } = {}): Howto | null {
  const variant = variantOf(check);
  if (!variant) return null;
  const record = (id: string) => plan.records.find((r) => r.id === id);
  const params: Params = {
    domain: plan.domain,
    ip: plan.ptr.ip,
    name: plan.ptr.expected,
    host: plan.serverHostname,
  };
  const copies: HowtoCopy[] = [];
  const nameValue = (id: string, value?: string) => {
    const r = record(id);
    if (!r) return;
    copies.push({ labelKey: k("howto.label.name"), value: r.name });
    copies.push({ labelKey: k("howto.label.value"), value: value ?? r.value });
  };

  switch (variant) {
    case "a": {
      const r = record(check.id === "helo" ? "a_helo" : "a");
      if (r) {
        copies.push({ labelKey: k("howto.label.name"), value: r.name });
        copies.push({ labelKey: k("howto.label.ip"), value: r.value });
      }
      break;
    }
    case "mx": {
      const r = record("mx");
      if (r) {
        copies.push({ labelKey: k("howto.label.name"), value: r.name });
        copies.push({ labelKey: k("howto.label.host"), value: r.value });
        if (r.priority !== undefined) copies.push({ labelKey: k("howto.label.priority"), value: String(r.priority) });
      }
      break;
    }
    case "spf":
      nameValue("spf", check.expected);
      break;
    case "dkim":
    case "dmarc":
      nameValue(variant, check.expected);
      break;
    case "ptr":
      copies.push({ labelKey: k("howto.label.ptrName"), value: plan.ptr.expected });
      copies.push({ labelKey: k("howto.label.ip"), value: plan.ptr.ip });
      copies.push({
        labelKey: k("howto.label.request"),
        messageKey: k("howto.ptr.request"),
        params: { ip: plan.ptr.ip, name: plan.ptr.expected },
      });
      break;
    case "port25":
      copies.push({
        labelKey: k("howto.label.request"),
        messageKey: k("howto.port25.request"),
        params: { ip: plan.ptr.ip },
      });
      break;
    case "mta_sts":
      nameValue("mta_sts");
      copies.push({ labelKey: k("howto.label.url"), value: `https://mta-sts.${plan.domain}/.well-known/mta-sts.txt` });
      copies.push({ labelKey: k("howto.label.policy"), value: plan.mtaStsPolicy });
      break;
    case "tls_rpt":
      nameValue("tls_rpt");
      break;
    case "dmarc_next_none":
    case "dmarc_next_quarantine": {
      const r = record("dmarc");
      const current = check.found?.[0] ?? r?.value;
      const from = variant === "dmarc_next_none" ? "none" : "quarantine";
      const to = variant === "dmarc_next_none" ? "quarantine" : "reject";
      if (r && current) {
        copies.push({ labelKey: k("howto.label.name"), value: r.name });
        copies.push({ labelKey: k("howto.label.current"), value: current });
        copies.push({ labelKey: k("howto.label.value"), value: current.replace(new RegExp(`\\bp=${from}\\b`, "i"), `p=${to}`) });
      }
      break;
    }
    default:
      break;
  }

  return {
    variant,
    optional: OPTIONAL.has(variant),
    nextStep: NEXT_STEP.has(variant),
    steps: Array.from({ length: HOWTO_STEP_COUNT[variant] }, (_, i) =>
      variant === "ptr" && i === 1 && ctx.hasHelo ? k("howto.ptr.2helo") : k(`howto.${variant}.${i + 1}`),
    ),
    gainKey: HOWTO_WITH_GAIN.has(variant) ? k(`howto.${variant}.gain`) : undefined,
    riskKey: HOWTO_WITH_RISK.has(variant) ? k(`howto.${variant}.risk`) : undefined,
    params,
    copies,
    severityKey: variant === "ptr" ? k("howto.ptr.severity") : undefined,
  };
}
