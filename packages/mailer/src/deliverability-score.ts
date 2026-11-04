/**
 * deliverability-score.ts — "Prontidão para a caixa de entrada" (0 a 100).
 *
 * Segue a seção 3.3 de comoFuncionaSistema/email/_PESQUISA-entregabilidade.md:
 * mede o que o painel consegue conferir e lembra o que não consegue. Nenhum
 * provedor publica a fórmula; a nota é um guia, não uma garantia.
 *
 * Honestidade:
 *  - o que não foi verificado ganha zero e aparece como "unknown";
 *  - um servidor novo NÃO chega ao verde antes do aquecimento (é de propósito:
 *    é exatamente o que explica o spam do começo).
 */
import type {
  BlacklistCheckResponse,
  DeliverabilityBand,
  DeliverabilityItem,
  DeliverabilityResponse,
  PostmasterMarks,
  PtrCheckStatus,
} from "@paas/core";

export interface DeliverabilityInput {
  now: Date;
  /** Última verificação de DNS de cada domínio (null = nunca verificado). */
  domains: Array<{ name: string; dnsOk: number | null; dnsTotal: number | null; ptr: PtrCheckStatus | null }>;
  factsAt: string | null;
  /** Nomes do servidor de e-mail com certificado válido (null = não conferido). */
  tls: { ok: number; total: number } | null;
  blacklist: BlacklistCheckResponse | null;
  /** Últimos 7 dias, do histórico de envios. */
  volume7d: { delivered: number; bounced: number; deferredRecipients: number; recipients: number };
  /** Primeiro envio registrado (null = nenhum ainda). */
  firstSendAt: string | null;
  marks: PostmasterMarks;
}

const DAY = 86_400_000;
const WARMUP_DAYS = 30;
const SPAM_CHECK_VALID_DAYS = 30;

export const GOOGLE_POSTMASTER_URL = "https://postmaster.google.com/";
export const MICROSOFT_SNDS_URL = "https://sendersupport.olc.protection.outlook.com/snds/";

/** 0,6% / 10% (pt-BR). */
export function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1).replace(".", ",")}%`;
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(fromIso).getTime()) / DAY);
}

function make(
  id: string,
  label: string,
  maxPoints: number,
  status: DeliverabilityItem["status"],
  points: number,
  detail: string,
  howTo: string | null,
  link: DeliverabilityItem["link"] = null,
): DeliverabilityItem {
  return { id, label, status, points, maxPoints, detail, howTo, link };
}

const MAIL_PAGE = { label: "Abrir a página E-mail", href: "/mail" };

function dnsItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "DNS do e-mail (SPF, DKIM, DMARC, A, MX)";
  if (input.domains.length === 0) {
    return make("dns", label, 25, "todo", 0, "Nenhum domínio de e-mail cadastrado.", "Cadastre o domínio de envio na página E-mail.", MAIL_PAGE);
  }
  const verified = input.domains.filter((d) => d.dnsOk !== null && d.dnsTotal !== null);
  if (verified.length < input.domains.length) {
    return make("dns", label, 25, "unknown", 0, "Ainda não verificado.", "Clique em \"Conferir agora\" ou em \"Verificar agora\" na página do domínio.", MAIL_PAGE);
  }
  let ok = 0;
  let total = 0;
  let shownOk = 0;
  let shownTotal = 0;
  for (const d of verified) {
    const ptrOk = d.ptr === "found" || d.ptr === "generic" ? 1 : 0;
    ok += d.dnsOk! - ptrOk;
    total += d.dnsTotal! - 1;
    shownOk += d.dnsOk!;
    shownTotal += d.dnsTotal!;
  }
  const points = Math.round((25 * ok) / total);
  const detail = `${shownOk}/${shownTotal} certos no checklist DNS (${verified.length === 1 ? "1 domínio" : `${verified.length} domínios`}).`;
  if (ok === total) return make("dns", label, 25, "done", 25, detail, null);
  return make("dns", label, 25, ok > 0 ? "partial" : "todo", points, detail, "Abra o domínio na página E-mail e corrija os registros em amarelo.", MAIL_PAGE);
}

function ptrItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "Nome reverso do IP (PTR)";
  const ptr = input.domains[0]?.ptr ?? null;
  switch (ptr) {
    case "found":
      return make("ptr", label, 10, "done", 10, "Personalizado: o nome reverso é o nome do servidor.", null);
    case "generic":
      return make(
        "ptr",
        label,
        10,
        "partial",
        5,
        "Genérico do provedor: funciona, mas um nome personalizado melhora a reputação.",
        "Troque o nome reverso do IP para o nome do servidor de e-mail (a página do domínio mostra onde, no seu provedor).",
        MAIL_PAGE,
      );
    case "mismatch":
    case "action_required":
    case "missing":
      return make("ptr", label, 10, "todo", 0, "Sem nome reverso válido: Gmail, Yahoo e Microsoft podem recusar.", "Configure o nome reverso do IP no painel do provedor da VPS.", MAIL_PAGE);
    default:
      return make("ptr", label, 10, "unknown", 0, "Ainda não verificado.", "Clique em \"Conferir agora\".", null);
  }
}

function tlsItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "Certificado do servidor de e-mail";
  if (!input.tls || input.tls.total === 0) {
    return make("tls", label, 5, "unknown", 0, "Ainda não conferido.", "Clique em \"Conferir agora\".", null);
  }
  const { ok, total } = input.tls;
  if (ok === total) return make("tls", label, 5, "done", 5, "Válido em todos os nomes do servidor.", null);
  return make("tls", label, 5, ok > 0 ? "partial" : "todo", 0, `Válido em ${ok} de ${total} nomes.`, "Veja o card do certificado na página E-mail.", MAIL_PAGE);
}

function blacklistItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "Listas de bloqueio";
  const check = input.blacklist;
  if (!check) return make("blacklist", label, 15, "unknown", 0, "Ainda não conferido.", "Clique em \"Conferir agora\".", null);
  const results = [check.ip, ...check.domains].flatMap((t) => (t ? t.results : []));
  const age = daysBetween(check.checkedAt, input.now);
  const stale = age >= 2 ? ` Conferido há ${age} dias.` : "";
  const spamhaus = results.filter((r) => r.dnsbl.startsWith("spamhaus"));
  const listed = results.filter((r) => r.status === "listed");
  const spamhausListed = spamhaus.find((r) => r.status === "listed");
  if (spamhausListed) {
    return make(
      "blacklist",
      label,
      15,
      "todo",
      0,
      `Listado na ${spamhausListed.label}: muitos servidores recusam.${stale}`,
      "Peça a remoção no site da Spamhaus depois de corrigir a causa (app enviando spam, senha vazada).",
      spamhausListed.removalUrl ? { label: "Pedir remoção", href: spamhausListed.removalUrl } : null,
    );
  }
  if (listed.length > 0) {
    return make(
      "blacklist",
      label,
      15,
      "todo",
      5,
      `Listado em: ${listed.map((r) => r.label).join(", ")}.${stale}`,
      "Peça a remoção no site da lista (link na seção Reputação).",
      null,
    );
  }
  if (spamhaus.length === 0 || spamhaus.some((r) => r.status !== "clean")) {
    return make(
      "blacklist",
      label,
      15,
      "unknown",
      0,
      `Não deu para conferir a Spamhaus a partir deste servidor.${stale}`,
      "Cadastre a chave DQS gratuita da Spamhaus na seção Reputação e confira de novo.",
      null,
    );
  }
  if (results.every((r) => r.status === "clean")) {
    return make("blacklist", label, 15, "done", 15, `Limpo em todas as listas conferidas.${stale}`, null);
  }
  const unknown = results.filter((r) => r.status === "unknown").map((r) => r.label);
  return make(
    "blacklist",
    label,
    15,
    "partial",
    12,
    `Spamhaus limpa; não deu para conferir: ${[...new Set(unknown)].join(", ")}.${stale}`,
    "Confira essas listas no site delas (links na seção Reputação).",
    null,
  );
}

function warmupItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "Aquecimento (tempo enviando)";
  const howTo = "Comece com pouco volume, para gente que abre e responde, e aumente devagar.";
  if (!input.firstSendAt) return make("warmup", label, 15, "todo", 0, "Nenhum envio registrado ainda.", howTo);
  const days = Math.max(0, daysBetween(input.firstSendAt, input.now));
  if (days >= WARMUP_DAYS) return make("warmup", label, 15, "done", 15, `Enviando há ${days} dias.`, null);
  return make(
    "warmup",
    label,
    15,
    "partial",
    Math.round((15 * days) / WARMUP_DAYS),
    `Enviando há ${days} ${days === 1 ? "dia" : "dias"}: o aquecimento leva cerca de ${WARMUP_DAYS} dias.`,
    howTo,
  );
}

function bouncesItem(input: DeliverabilityInput): DeliverabilityItem {
  const label = "Recusas e adiamentos (7 dias)";
  const v = input.volume7d;
  if (v.recipients === 0) return make("bounces", label, 10, "unknown", 0, "Sem envios nos últimos 7 dias.", null);
  const rate = Math.min(1, (v.bounced + v.deferredRecipients) / v.recipients);
  const detail = `${formatPercent(rate)} dos destinatários tiveram recusa ou adiamento.`;
  const howTo = "Veja os motivos no Histórico e pare de enviar para endereços que não existem.";
  if (rate < 0.02) return make("bounces", label, 10, "done", 10, detail, null);
  if (rate < 0.05) return make("bounces", label, 10, "partial", 5, detail, howTo);
  return make("bounces", label, 10, "todo", 0, detail, howTo);
}

function markItems(input: DeliverabilityInput): DeliverabilityItem[] {
  const { googleAt, microsoftAt, spamRateOkAt } = input.marks;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "UTC" });
  const google = googleAt
    ? make("google-postmaster", "Google Postmaster Tools cadastrado", 3, "done", 3, `Cadastrado em ${fmt(googleAt)}.`, null, {
        label: "Abrir o Postmaster Tools",
        href: GOOGLE_POSTMASTER_URL,
      })
    : make(
        "google-postmaster",
        "Google Postmaster Tools cadastrado",
        3,
        "todo",
        0,
        "Ainda não marcado.",
        "Entre com uma conta Google, adicione o domínio de envio e cole no DNS o TXT de verificação. Depois marque aqui.",
        { label: "Abrir o Postmaster Tools", href: GOOGLE_POSTMASTER_URL },
      );
  const microsoft = microsoftAt
    ? make("microsoft-snds", "Microsoft SNDS cadastrado", 2, "done", 2, `Cadastrado em ${fmt(microsoftAt)}.`, null, {
        label: "Abrir o SNDS",
        href: MICROSOFT_SNDS_URL,
      })
    : make(
        "microsoft-snds",
        "Microsoft SNDS cadastrado",
        2,
        "todo",
        0,
        "Ainda não marcado.",
        "Cadastre o IP da VPS no SNDS da Microsoft (Outlook/Hotmail). Depois marque aqui.",
        { label: "Abrir o SNDS", href: MICROSOFT_SNDS_URL },
      );
  const spamLabel = "Taxa de spam abaixo de 0,1% (Postmaster Tools)";
  const spamHow = "Confira no Postmaster Tools a taxa de spam dos últimos dias e marque aqui quando estiver abaixo de 0,1%.";
  const spam = !spamRateOkAt
    ? make("spam-rate", spamLabel, 10, "todo", 0, "Ainda não conferido.", spamHow, { label: "Abrir o Postmaster Tools", href: GOOGLE_POSTMASTER_URL })
    : daysBetween(spamRateOkAt, input.now) > SPAM_CHECK_VALID_DAYS
      ? make("spam-rate", spamLabel, 10, "partial", 5, `Conferido em ${fmt(spamRateOkAt)}, há mais de ${SPAM_CHECK_VALID_DAYS} dias.`, spamHow, {
          label: "Abrir o Postmaster Tools",
          href: GOOGLE_POSTMASTER_URL,
        })
      : make("spam-rate", spamLabel, 10, "done", 10, `Conferido em ${fmt(spamRateOkAt)}.`, null);
  return [google, microsoft, spam];
}

function dmarcItem(): DeliverabilityItem {
  return make(
    "dmarc-reports",
    "Relatórios DMARC sem falha",
    5,
    "unknown",
    0,
    "O painel ainda não lê os relatórios DMARC (eles chegam na caixa postmaster@ do domínio).",
    "Abra a caixa postmaster@ num programa de e-mail e confira os relatórios do Google e da Microsoft.",
  );
}

/** Nota, faixa e a lista "o que está feito / o que falta". */
export function deliverabilityScore(input: DeliverabilityInput): Omit<DeliverabilityResponse, "marks" | "factsAt"> {
  const items = [
    dnsItem(input),
    ptrItem(input),
    tlsItem(input),
    blacklistItem(input),
    warmupItem(input),
    bouncesItem(input),
    ...markItems(input),
    dmarcItem(),
  ];
  const score = items.reduce((acc, i) => acc + i.points, 0);
  const band: DeliverabilityBand = score >= 85 ? "green" : score >= 60 ? "yellow" : "red";
  return { score, max: 100, band, items };
}
