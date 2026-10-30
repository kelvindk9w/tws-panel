/**
 * timezone.ts — fuso horário da VPS e dos projetos (Configurações → Fuso
 * horário, assistente de instalação e o campo "Fuso horário" do projeto).
 *
 * Os nomes aceitos vêm de uma lista fechada (IANA_ZONE_NAMES, gerada do
 * zone.tab) mais "UTC" e "Etc/UTC". É por ela que o nome chega ao comando que
 * troca o fuso no host: nunca texto livre.
 */
import { IANA_ZONE_NAMES } from "./timezone-names";

export { IANA_ZONE_NAMES };

/** Fusos do Brasil, na ordem em que aparecem no seletor. */
export const BRAZIL_TIMEZONES: readonly string[] = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Fortaleza",
  "America/Recife",
  "America/Bahia",
  "America/Belem",
  "America/Cuiaba",
  "America/Campo_Grande",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Noronha",
  "America/Araguaina",
  "America/Maceio",
  "America/Santarem",
];

/** Onde cada fuso do Brasil vale, para a pessoa achar o seu. */
export const BRAZIL_TIMEZONE_PLACES: Readonly<Record<string, string>> = {
  "America/Sao_Paulo": "Brasília, Sul, Sudeste, Goiás e DF",
  "America/Manaus": "Amazonas (quase todo)",
  "America/Fortaleza": "Ceará, Piauí, Maranhão e Rio Grande do Norte",
  "America/Recife": "Pernambuco",
  "America/Bahia": "Bahia",
  "America/Belem": "Pará (leste) e Amapá",
  "America/Cuiaba": "Mato Grosso",
  "America/Campo_Grande": "Mato Grosso do Sul",
  "America/Porto_Velho": "Rondônia",
  "America/Boa_Vista": "Roraima",
  "America/Rio_Branco": "Acre e oeste do Amazonas",
  "America/Noronha": "Fernando de Noronha",
  "America/Araguaina": "Tocantins",
  "America/Maceio": "Alagoas e Sergipe",
  "America/Santarem": "Pará (oeste)",
};

/** Nomes sem cidade que também são aceitos. */
const UTC_NAMES: readonly string[] = ["UTC", "Etc/UTC"];

/**
 * Formato de um nome de fuso (Região/Cidade, até três partes, ou UTC).
 * Vale para nomes LIDOS (do host, do .env); para trocar o fuso, além do
 * formato o nome precisa estar na lista (isKnownTimezone).
 */
export const TIMEZONE_NAME_RE = /^(?:UTC|[A-Z][A-Za-z]+(?:\/[A-Za-z0-9_+-]{1,40}){1,2})$/;

export function isSafeTimezoneName(name: string): boolean {
  return TIMEZONE_NAME_RE.test(name);
}

const KNOWN = new Set<string>([...IANA_ZONE_NAMES, ...UTC_NAMES]);

/** O nome está na lista IANA (ou é UTC). */
export function isKnownTimezone(name: string): boolean {
  return KNOWN.has(name) && isSafeTimezoneName(name);
}

/** Ordem do seletor: Brasil, UTC e depois os demais em ordem alfabética. */
export function timezoneChoices(): string[] {
  const brazil = new Set(BRAZIL_TIMEZONES);
  const rest = IANA_ZONE_NAMES.filter((z) => !brazil.has(z)).sort((a, b) => a.localeCompare(b));
  return [...BRAZIL_TIMEZONES, "UTC", ...rest];
}

/** Deslocamento do fuso em minutos (positivo a leste) no instante `at`; null se o fuso for desconhecido aqui. */
export function timezoneOffsetMinutes(zone: string, at: Date = new Date()): number | null {
  let text: string;
  try {
    text = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")!.value;
  } catch {
    return null;
  }
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(text);
  if (!m) return 0; // "GMT" puro = UTC
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/** 0 → "UTC"; −180 → "UTC−3"; 330 → "UTC+5:30". Usa o sinal de menos tipográfico. */
export function formatUtcOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${minutes < 0 ? "−" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** Um item do seletor de fusos. */
export interface TimezoneOption {
  zone: string;
  /** Deslocamento agora, ex.: "UTC−3"; null se o fuso for desconhecido no servidor. */
  offset: string | null;
  /** Onde vale (só os do Brasil). */
  place: string | null;
  brazil: boolean;
}

export function timezoneOptions(at: Date = new Date()): TimezoneOption[] {
  const brazil = new Set(BRAZIL_TIMEZONES);
  return timezoneChoices().map((zone) => {
    const off = timezoneOffsetMinutes(zone, at);
    return {
      zone,
      offset: off === null ? null : formatUtcOffset(off),
      place: BRAZIL_TIMEZONE_PLACES[zone] ?? null,
      brazil: brazil.has(zone),
    };
  });
}

// ---------------------------------------------------------------------------
// Fuso da VPS (GET/PUT /api/timezone)
// ---------------------------------------------------------------------------

/**
 * De onde veio o fuso que o painel usa:
 *  - env: TZ no /opt/tws-panel/.env (tem prioridade);
 *  - host: lido agora da VPS pelo host bridge;
 *  - saved: o último lido da VPS, guardado em data/timezone.json;
 *  - localtime: deduzido do /etc/localtime montado (pode estar desatualizado);
 *  - default: nada encontrado, UTC.
 */
export type TimezoneSource = "env" | "host" | "saved" | "localtime" | "default";

/** Fuso escolhido para um projeto. */
export type ProjectTimezoneMode = "image" | "host" | "zone";

export interface ProjectTimezoneSetting {
  /** image = o da imagem (nada é injetado); host = igual ao da VPS; zone = um fuso específico. */
  mode: ProjectTimezoneMode;
  /** Só com mode "zone". */
  zone?: string;
}

export interface TimezoneProjectRow {
  id: string;
  name: string;
  setting: ProjectTimezoneSetting;
  /** O fuso que o projeto recebe com essa escolha (null = o da imagem). */
  effectiveZone: string | null;
}

export interface TimezoneStatus {
  /** Fuso que o painel usa agora. */
  zone: string;
  offset: string;
  source: TimezoneSource;
  /** TZ do .env do painel, quando definido (ele vence o da VPS ao reiniciar). */
  envOverride: string | null;
  /** Último fuso lido da VPS pelo host bridge (null = não deu para ler). */
  hostZone: string | null;
  hostReadAt: string | null;
  hostError: string | null;
  /** O painel consegue trocar o fuso da VPS (host bridge disponível). */
  canApply: boolean;
  /** Por que não dá para aplicar (quando canApply é false). */
  cannotApplyReason: string | null;
  /** Hora atual no servidor (ISO). */
  now: string;
  options: TimezoneOption[];
  projects: TimezoneProjectRow[];
}

export interface SetTimezoneRequest {
  zone: string;
  /** Projetos marcados em "Aplicar também nestes projetos": passam a "Igual ao da VPS" e reiniciam. */
  projects?: string[];
}

export interface TimezoneProjectResult {
  id: string;
  name: string;
  /** Reinício iniciado (acompanhe na aba Deploys). */
  jobId: string | null;
  error: string | null;
}

export interface SetTimezoneResponse {
  status: TimezoneStatus;
  projects: TimezoneProjectResult[];
}

// ---------------------------------------------------------------------------
// Fuso do projeto (GET/PUT /api/projects/:id/timezone)
// ---------------------------------------------------------------------------

/** TZ que o próprio projeto define (e por isso o painel não mexe). */
export interface ProjectTimezoneDefinition {
  service: string;
  value: string;
  /** compose = environment do serviço; variables = seção Variáveis (.env); env_file = outro arquivo. */
  where: "compose" | "variables" | "env_file" | "dockerfile";
}

export interface ProjectTimezoneService {
  service: string;
  container: string;
  running: boolean;
  /** TZ no ambiente do container agora (null = sem TZ). */
  tz: string | null;
  /** O container tem a base de fusos para esse TZ (/usr/share/zoneinfo); null = não deu para conferir. */
  zoneinfo: boolean | null;
}

/** Serviço de banco/cache excluído da injeção de TZ. */
export interface ProjectTimezoneExcluded {
  service: string;
  image: string;
}

/**
 * Imagens de banco/cache: o painel não injeta TZ nelas (o Postgres só lê o fuso no initdb e o MySQL
 * passaria a divergir dos apps que gravam em UTC). Casa pelo nome da imagem, com ou sem registro/namespace.
 */
const DATABASE_IMAGE_NAMES = new Set([
  "mysql", "mariadb", "percona", "postgres", "postgis", "timescaledb", "pgvector", "mongo", "mongodb",
  "redis", "valkey", "keydb", "dragonfly", "memcached", "cassandra", "couchdb", "clickhouse", "cockroach",
]);

export function isDatabaseImage(image: string | null | undefined): boolean {
  if (!image) return false;
  // tira ${VAR} do tag/digest e fica com o último segmento do caminho (registro/namespace/nome:tag@digest)
  const last = image.trim().toLowerCase().split("@")[0]!.split("/").pop() ?? "";
  const name = last.split(":")[0] ?? "";
  if (DATABASE_IMAGE_NAMES.has(name)) return true;
  // variações comuns: postgres-alpine, bitnami/postgresql, mysql-server, redis-stack, mongo-express (não é banco)
  if (/^(postgresql|mysql-server|mysql-cluster|mariadb-galera|redis-stack(-server)?|redis-cluster|mongodb-community-server)$/.test(name)) return true;
  return false;
}

export interface ProjectTimezoneView {
  setting: ProjectTimezoneSetting;
  /** O fuso que a escolha injeta (null = o da imagem). */
  effectiveZone: string | null;
  /** Fuso da VPS agora (para "Igual ao da VPS"). */
  hostZone: string;
  definedByProject: ProjectTimezoneDefinition[];
  /** O que o último deploy/reinício injetou (null = nada). */
  appliedZone: string | null;
  /** A escolha ainda não está nos containers: falta reiniciar. */
  pendingRestart: boolean;
  /** Tipo de projeto aceita fuso (site estático não tem processo). */
  supported: boolean;
  /** Serviços de banco/cache que o painel não mexe (imagem reconhecida). */
  excluded: ProjectTimezoneExcluded[];
  /** Algum serviço recebe de fato o fuso escolhido (false = todos definem o próprio TZ ou são excluídos). */
  receivesZone: boolean;
  /** Framework do app, quando reconhecido (Laravel ignora TZ e usa APP_TIMEZONE). */
  framework: "laravel" | null;
  /** O projeto já tem a variável APP_TIMEZONE nas Variáveis. */
  appTimezoneSet: boolean;
  services: ProjectTimezoneService[];
  options: TimezoneOption[];
}

export interface ProjectTimezoneRequest {
  mode: ProjectTimezoneMode;
  zone?: string;
}

/** O fuso que uma escolha injeta, dado o fuso da VPS. */
export function effectiveProjectZone(setting: ProjectTimezoneSetting | undefined, hostZone: string): string | null {
  if (!setting || setting.mode === "image") return null;
  if (setting.mode === "host") return hostZone;
  return setting.zone ?? null;
}
