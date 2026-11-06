/**
 * docker-cleanup.ts — limpeza do Docker (cache de build e imagens sem uso antigas).
 *
 * Contrato entre o serviço do servidor e a tela Configurações → Limpeza do Docker.
 * Regras que valem em tudo:
 *  - o verificador só LÊ; quem remove é a limpeza (manual ou automática);
 *  - nunca se mexe em volumes nem em containers;
 *  - as imagens fixadas do painel (images.ts) e as dos repositórios do painel nunca são removidas;
 *  - a limpeza automática nasce DESLIGADA.
 */

export type DockerCleanupFrequency = "daily" | "weekly" | "monthly";

export const DOCKER_CLEANUP_FREQUENCIES: readonly DockerCleanupFrequency[] = ["daily", "weekly", "monthly"];

/** Intervalo de cada frequência, em dias. */
export const DOCKER_CLEANUP_FREQUENCY_DAYS: Readonly<Record<DockerCleanupFrequency, number>> = { daily: 1, weekly: 7, monthly: 30 };

export interface DockerCleanupSettings {
  /** Limpeza automática ligada (padrão: desligada; o verificador funciona sempre). */
  enabled: boolean;
  frequency: DockerCleanupFrequency;
  /** Só entra na limpeza o cache de build sem uso há mais que isto e a imagem sem container criada há mais que isto (dias). */
  minAgeDays: number;
  /** Limpa também quando o disco passar deste uso (%). null = não limpar por uso do disco. */
  diskTriggerPercent: number | null;
  /** O painel avisa quando a limpeza possível passar deste tanto (GB). */
  warnGainGb: number;
  /** O painel avisa também quando o disco passar deste uso (%) e houver o que limpar. */
  warnDiskPercent: number;
}

export const DOCKER_CLEANUP_DEFAULTS: Readonly<DockerCleanupSettings> = {
  enabled: false,
  frequency: "weekly",
  minAgeDays: 7,
  diskTriggerPercent: null,
  warnGainGb: 10,
  warnDiskPercent: 80,
};

export const DOCKER_CLEANUP_LIMITS = {
  minAgeDays: { min: 1, max: 365 },
  diskTriggerPercent: { min: 50, max: 99 },
  warnGainGb: { min: 1, max: 1000 },
  warnDiskPercent: { min: 50, max: 99 },
} as const;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Confere (e completa com o padrão) as configurações vindas do disco ou da tela. */
export function validateDockerCleanupSettings(raw: unknown): { ok: true; value: DockerCleanupSettings } | { ok: false } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const r = raw as Record<string, unknown>;
  const d = DOCKER_CLEANUP_DEFAULTS;
  const enabled = r.enabled ?? d.enabled;
  const frequency = r.frequency ?? d.frequency;
  const minAgeDays = r.minAgeDays ?? d.minAgeDays;
  const trigger = r.diskTriggerPercent === undefined ? d.diskTriggerPercent : r.diskTriggerPercent;
  const warnGainGb = r.warnGainGb ?? d.warnGainGb;
  const warnDiskPercent = r.warnDiskPercent ?? d.warnDiskPercent;
  const L = DOCKER_CLEANUP_LIMITS;
  if (typeof enabled !== "boolean") return { ok: false };
  if (typeof frequency !== "string" || !(DOCKER_CLEANUP_FREQUENCIES as readonly string[]).includes(frequency)) return { ok: false };
  if (!isInt(minAgeDays, L.minAgeDays.min, L.minAgeDays.max)) return { ok: false };
  if (trigger !== null && !isInt(trigger, L.diskTriggerPercent.min, L.diskTriggerPercent.max)) return { ok: false };
  if (!isInt(warnGainGb, L.warnGainGb.min, L.warnGainGb.max)) return { ok: false };
  if (!isInt(warnDiskPercent, L.warnDiskPercent.min, L.warnDiskPercent.max)) return { ok: false };
  return {
    ok: true,
    value: { enabled, frequency: frequency as DockerCleanupFrequency, minAgeDays, diskTriggerPercent: trigger as number | null, warnGainGb, warnDiskPercent },
  };
}

export type DockerCleanupProtectedReason =
  /** Fixada pelo painel (images.ts) ou de um repositório do próprio painel. */
  | "panel"
  /** Algum container (parado ou rodando) usa a imagem. */
  | "in_use"
  /** Mais nova que a idade mínima. */
  | "recent";

export interface DockerCleanupImage {
  /** Id completo (sha256:…) da imagem. */
  id: string;
  /** Nomes (repositório:tag); vazio = imagem sem nome. */
  tags: string[];
  /** Bytes que seriam liberados (a parte que só esta imagem usa). */
  bytes: number;
  /** Quando foi criada (ISO). */
  createdAt: string;
  ageDays: number;
}

export interface DockerCleanupProtectedImage extends DockerCleanupImage {
  reason: DockerCleanupProtectedReason;
}

export interface DockerCleanupDisk {
  totalBytes: number;
  usedBytes: number;
  usedPercent: number;
}

/** O que a verificação encontrou. */
export interface DockerCleanupScan {
  /** Quando foi verificado (ISO). */
  scannedAt: string;
  minAgeDays: number;
  buildCache: { bytes: number; entries: number; totalBytes: number };
  images: { bytes: number; candidates: DockerCleanupImage[]; protected: DockerCleanupProtectedImage[] };
  /** Soma do que a limpeza liberaria. */
  totalBytes: number;
  /** O ganho em % do disco inteiro (null = disco desconhecido). */
  totalPercentOfDisk: number | null;
  disk: DockerCleanupDisk | null;
}

export type DockerCleanupTrigger = "manual" | "schedule" | "disk";
export type DockerCleanupResult = "success" | "partial" | "failed";

export interface DockerCleanupRecord {
  id: string;
  /** ISO. */
  at: string;
  trigger: DockerCleanupTrigger;
  /** Quem pediu (usuário do painel) ou "automática". */
  actor: string;
  result: DockerCleanupResult;
  minAgeDays: number;
  buildCacheBytes: number;
  imagesBytes: number;
  freedBytes: number;
  /** Imagens removidas (nome ou id curto), até 200. */
  removedImages: string[];
  /** Falhas por imagem ou do cache de build (texto curto). */
  errors: string[];
}

/** Por que a limpeza não pôde rodar agora. */
export type DockerCleanupBlock = "deploy" | "backup" | "cleaning" | "docker_unavailable";

export interface DockerCleanupState {
  settings: DockerCleanupSettings;
  defaults: DockerCleanupSettings;
  limits: typeof DOCKER_CLEANUP_LIMITS;
  lastScan: DockerCleanupScan | null;
  /** Há uma verificação ou limpeza em andamento. */
  working: boolean;
  /** Motivo de a limpeza estar travada agora (null = livre). */
  blocked: DockerCleanupBlock | null;
  /** O ganho possível passou do limite de aviso. */
  warning: boolean;
  nextRunAt: string | null;
  history: DockerCleanupRecord[];
}

export interface UpdateDockerCleanupSettingsRequest {
  settings: DockerCleanupSettings;
}

/**
 * A limpeza só roda com a confirmação de que a pessoa viu a lista (o "o que será removido"). O servidor recalcula
 * na hora e remove só a interseção com o que foi mostrado: nada que a pessoa não viu sai.
 */
export interface RunDockerCleanupRequest {
  confirm: true;
  /** Ids (sha256:…) das imagens da lista mostrada. */
  imageIds: string[];
  /** A lista mostrava cache de build para limpar. */
  buildCache: boolean;
  /** Idade mínima da verificação mostrada (vale a maior entre esta e a configurada). */
  minAgeDays: number;
}

/** O pedido de "Limpar agora" que corresponde ao que a verificação mostrou. */
export function dockerCleanupRunRequest(scan: DockerCleanupScan): RunDockerCleanupRequest {
  return { confirm: true, imageIds: scan.images.candidates.map((c) => c.id), buildCache: scan.buildCache.entries > 0, minAgeDays: scan.minAgeDays };
}

/** Decide se o resultado da verificação merece aviso. */
export function dockerCleanupWarns(scan: DockerCleanupScan | null, settings: Pick<DockerCleanupSettings, "warnGainGb" | "warnDiskPercent">): boolean {
  if (!scan || scan.totalBytes <= 0) return false;
  if (scan.totalBytes >= settings.warnGainGb * 1024 ** 3) return true;
  return scan.disk !== null && scan.disk.usedPercent >= settings.warnDiskPercent;
}
