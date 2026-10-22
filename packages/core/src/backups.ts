/**
 * backups.ts — backups do painel, do e-mail e dos projetos (Configurações →
 * Backups e aba Backups de cada projeto).
 *
 * Princípio combinado com o dono do produto: o código NÃO entra no backup
 * (ele vem do GitHub). Entra só o que não existe em outro lugar: bancos de
 * dados (dump pela ferramenta do próprio banco), volumes e pastas com
 * arquivos dos usuários, o diretório de dados do painel e os dados do
 * servidor de e-mail.
 *
 * Cada backup é um arquivo .7z que abre no 7-Zip/Keka sem o painel. A cópia
 * na VPS fica sem senha; a cópia externa (armazenamento compatível com S3,
 * como o Cloudflare R2) pode ir cifrada com AES-256 e nomes cifrados.
 */

/** Pasta raiz no armazenamento externo. */
export const BACKUP_ROOT_FOLDER = "TWS Panel Backups";

/** A cada quantas horas o backup roda. */
export type BackupFrequencyHours = 24 | 12 | 6;
export const BACKUP_FREQUENCIES: readonly BackupFrequencyHours[] = [24, 12, 6];

/** Hora do primeiro backup do dia, no fuso da VPS (de madrugada). */
export const DEFAULT_BACKUP_HOUR = 3;
/** Cópias guardadas na VPS por item. */
export const DEFAULT_LOCAL_KEEP = 2;
/** Cópias guardadas no armazenamento externo por item. */
export const DEFAULT_REMOTE_KEEP = 5;
export const MAX_BACKUP_KEEP = 60;
/** Tamanho mínimo da senha dos backups. */
export const MIN_BACKUP_PASSWORD_LENGTH = 12;
export const MAX_BACKUP_PASSWORD_LENGTH = 200;
/** De quanto em quanto tempo o painel pergunta se a pessoa ainda tem a senha. */
export const BACKUP_PASSWORD_REMINDER_DAYS = 90;

/** O que pode ter backup. */
export type BackupTargetKind = "panel" | "email" | "project";

/**
 * Identificador de um item: "panel", "email" ou "project:<id do projeto>".
 */
export type BackupTargetId = string;

/** Pasta do item no armazenamento (e na VPS). */
export function backupFolderFor(target: { kind: "panel" } | { kind: "email" } | { kind: "project"; slug: string }): string {
  if (target.kind === "panel") return "_painel";
  if (target.kind === "email") return "_email";
  return target.slug;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "AAAA-MM-DD_HH-MM" no horário local (o fuso da VPS). */
export function backupFileStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:-(\d{1,3}))?\.7z$/;

/** Nome gerado pelo painel (sem barra, sem "..", sempre .7z). */
export function isValidBackupFileName(name: string): boolean {
  return FILE_RE.test(name);
}

/** Data de um arquivo de backup pelo nome; null se não for um nome do painel. */
export function parseBackupFileStamp(name: string): Date | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Quantas horas para trás os backups guardados alcançam. */
export function backupCoverageHours(frequencyHours: number, keep: number): number {
  return Math.max(0, frequencyHours * keep);
}

/** "os últimos 5 dias", "as últimas 12 horas"… para a frase "seus backups cobrem …". */
export function formatBackupCoverage(hours: number): string {
  if (hours <= 0) return "nenhum período";
  if (hours === 1) return "a última 1 hora";
  if (hours <= 24 || (hours < 48 && hours % 24 !== 0)) return `as últimas ${hours} horas`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `os últimos ${days} dias` : `os últimos ${days} dias e ${rest} horas`;
}

// ---------------------------------------------------------------------------
// Senha dos backups
// ---------------------------------------------------------------------------

export interface BackupPasswordStrength {
  /** 0 (muito fraca) a 4 (forte). */
  score: 0 | 1 | 2 | 3 | 4;
  label: "Curta demais" | "Fraca" | "Razoável" | "Boa" | "Forte";
  /** Pode ser usada: tem o tamanho mínimo e não é óbvia. */
  ok: boolean;
}

/**
 * Estimativa simples (sem dicionário): tamanho, variedade de caracteres e
 * penalidade para repetição e sequência. Serve para orientar enquanto a
 * pessoa digita; quem decide o mínimo é o tamanho.
 */
export function backupPasswordStrength(password: string): BackupPasswordStrength {
  if (password.length < MIN_BACKUP_PASSWORD_LENGTH) {
    return { score: password.length === 0 ? 0 : 1, label: "Curta demais", ok: false };
  }
  const unique = new Set(password).size;
  let sequential = 0;
  for (let i = 1; i < password.length; i++) {
    const diff = password.charCodeAt(i) - password.charCodeAt(i - 1);
    if (diff === 1 || diff === -1 || diff === 0) sequential++;
  }
  if (unique <= 3 || sequential / (password.length - 1) > 0.6) {
    return { score: 1, label: "Fraca", ok: false };
  }
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 20;
  const bits = Math.log2(pool) * Math.min(password.length, unique * 2);
  if (bits >= 100) return { score: 4, label: "Forte", ok: true };
  if (bits >= 72) return { score: 3, label: "Boa", ok: true };
  return { score: 2, label: "Razoável", ok: true };
}

// ---------------------------------------------------------------------------
// Detecção (aba Backups do projeto)
// ---------------------------------------------------------------------------

export type BackupDatabaseEngine = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

export const BACKUP_ENGINE_LABELS: Readonly<Record<BackupDatabaseEngine, string>> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongo: "MongoDB",
  redis: "Redis",
};

/** Um banco encontrado num serviço do projeto. */
export interface DetectedDatabase {
  /** "db:<serviço>". */
  id: string;
  service: string;
  engine: BackupDatabaseEngine;
  image: string;
  /** Banco e usuário lidos do ambiente do container (nunca a senha). */
  databaseName: string | null;
  user: string | null;
  /** Marcado por padrão (Redis vem desmarcado: costuma ser cache). */
  defaultSelected: boolean;
  /** Como o backup é feito, em uma frase. */
  method: string;
}

/** Um volume nomeado ou pasta montada de um serviço. */
export interface DetectedMount {
  /** "mnt:<serviço>:<destino>". */
  id: string;
  service: string;
  type: "volume" | "bind";
  /** Nome do volume (volume) ou caminho no servidor (bind). */
  source: string;
  /** Caminho dentro do container. */
  destination: string;
  sizeBytes: number | null;
  /** Já entra pelo dump do banco: não é oferecido. */
  coveredByDump: boolean;
  /** Montagem de um arquivo só (geralmente configuração do repositório). */
  isFile: boolean;
  defaultSelected: boolean;
  /** Por que veio (ou não) marcado. */
  reason: string;
}

/** Arquivos gravados fora de volume num container (somem a cada deploy). */
export interface UnsavedWrites {
  service: string;
  count: number;
  /** Alguns caminhos de exemplo. */
  samples: string[];
}

/** Pasta que o painel não detectou, adicionada à mão. */
export interface ExtraBackupFolder {
  id: string;
  service: string;
  path: string;
}

export interface ProjectBackupDetection {
  detectedAt: string;
  databases: DetectedDatabase[];
  mounts: DetectedMount[];
  unsavedWrites: UnsavedWrites[];
  /** O código não vem do GitHub (envio/pasta do servidor): oferecemos a pasta do código. */
  sourceFolder: { path: string; sizeBytes: number | null } | null;
  /** O que não deu para conferir (container parado, Docker fora). */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Situação (GET /api/backups)
// ---------------------------------------------------------------------------

export type BackupProvider = "r2" | "s3";

export interface BackupDestinationInfo {
  type: "s3";
  provider: BackupProvider;
  endpoint: string;
  region: string;
  bucket: string;
  /** Só o fim da chave de acesso, para conferir qual está em uso. */
  accessKeyHint: string;
  connectedAt: string;
  testedAt: string | null;
}

export interface BackupEncryptionInfo {
  /** Cifrar a cópia externa (vem ligado). */
  enabled: boolean;
  passwordSet: boolean;
  passwordSetAt: string | null;
  /** A pessoa marcou "Guardei a senha em lugar seguro". */
  acknowledgedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

export type BackupRunStatus = "queued" | "running" | "success" | "warning" | "failed";
export type BackupRemoteState = "none" | "uploading" | "uploaded" | "verified" | "failed" | "skipped";

export interface BackupRunStep {
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}

/** Qual cópia de um backup: a da VPS ou a do armazenamento externo. */
export type BackupCopyWhere = "local" | "remote";

/**
 * Resultado da conferência de uma cópia ("Conferir"):
 *  - ok: íntegra (tamanho, hash quando conhecido e `7z t`);
 *  - failed: não abriu, hash ou tamanho diferente, ou sem senha quando deveria ter;
 *  - missing: a cópia não existe mais (a retenção apagou);
 *  - needs_password: não abre com a senha guardada; falta a senha da época.
 */
export type BackupCheckStatus = "ok" | "failed" | "missing" | "needs_password";

export interface BackupCheckResult {
  status: BackupCheckStatus;
  at: string;
  reason: string | null;
}

/** Uma cópia dentro de uma conferência (um item da fila de "Conferir todos"). */
export interface BackupVerifyItem {
  target: BackupTargetId;
  targetName: string;
  fileName: string;
  where: BackupCopyWhere;
  status: BackupCheckStatus | "pending" | "running";
  reason: string | null;
}

export interface BackupVerifySummary {
  ok: number;
  failed: number;
  missing: number;
  needsPassword: number;
}

/** "Conferir" (um backup) ou "Conferir todos" (de um item ou de tudo). */
export interface BackupVerifyRequest {
  /** Sem nome = todos os backups do item (ou de tudo, em /api/backups/verify). */
  fileName?: string;
  /** Qual cópia; padrão as duas. */
  where?: BackupCopyWhere | "both";
  /** Senha da época, quando a guardada não abre a cópia externa. Nunca é guardada. */
  password?: string;
}

/** Item especial das conferências gerais. */
export const BACKUP_ALL_TARGETS = "all";

/** Um backup, uma restauração ou uma conferência (histórico). */
export interface BackupRecord {
  id: string;
  /** Item; "all" numa conferência de todos os backups. */
  target: BackupTargetId;
  targetName: string;
  operation: "backup" | "restore" | "verify" | "restore_check";
  trigger: "schedule" | "manual";
  status: BackupRunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  /** Cópia na VPS. */
  local: boolean;
  remote: BackupRemoteState;
  remoteEncrypted: boolean;
  remoteDetail: string | null;
  steps: BackupRunStep[];
  warnings: string[];
  error: string | null;
  /** Backup: a cópia da VPS ainda existe (preenchido na situação). */
  localExists?: boolean;
  /** Backup: última conferência da cópia da VPS. */
  localCheck?: BackupCheckResult | null;
  /** Backup: última conferência da cópia externa (a automática, depois do envio, conta). */
  remoteCheck?: BackupCheckResult | null;
  /** Conferência: cada cópia e o resumo. */
  verify?: { items: BackupVerifyItem[]; summary: BackupVerifySummary };
}

export interface BackupTargetSettings {
  enabled: boolean;
  frequencyHours: BackupFrequencyHours;
  localKeep: number;
  remoteKeep: number;
}

export interface BackupTargetStatus extends BackupTargetSettings {
  id: BackupTargetId;
  kind: BackupTargetKind;
  name: string;
  /** Pasta no armazenamento (e na VPS). */
  folder: string;
  lastBackup: BackupRecord | null;
  lastSuccessAt: string | null;
  lastRemoteVerifiedAt: string | null;
  nextRunAt: string | null;
  /** E-mail: o servidor de e-mail existe nesta instalação. */
  available: boolean;
  /**
   * Só projetos: true = segue o "Padrão dos projetos" (Configurações →
   * Backups) e muda junto com ele; false = configuração própria.
   */
  followsDefaults?: boolean;
  /**
   * Por que o backup automático deste item está em pausa (texto para a tela);
   * ausente/null = a agenda está valendo. Hoje: logo depois de restaurar o
   * painel de outro servidor, ou painel recém-instalado que não deve
   * sobrescrever os backups de outro servidor.
   */
  pausedReason?: string | null;
  /** Só projetos: resumo do teste de restauração (selo em Configurações → Backups). */
  restoreCheck?: { enabled: boolean; last: RestoreCheckResult | null };
}

export interface BackupsStatus {
  destination: BackupDestinationInfo | null;
  encryption: BackupEncryptionInfo;
  targets: BackupTargetStatus[];
  /** "Padrão dos projetos": com o que um projeto novo nasce. */
  projectDefaults: BackupTargetSettings;
  running: BackupRecord | null;
  queued: BackupRecord[];
  history: BackupRecord[];
  /** Fuso da VPS, ex.: "UTC-03:00". */
  timezone: string;
  /** Nome do fuso da VPS, ex.: "America/Sao_Paulo" (Configurações → Fuso horário). */
  timezoneName?: string;
  backupHour: number;
  /** O 7-Zip está instalado no container do painel. */
  archiverAvailable: boolean;
  /** Onde ficam as cópias na VPS. */
  localPath: string;
}

/** Aba Backups do projeto. */
export interface ProjectBackupView {
  target: BackupTargetStatus;
  detection: ProjectBackupDetection | null;
  /** Escolha da pessoa por item (ausente = o padrão de cada um). */
  choices: Record<string, boolean>;
  extraFolders: ExtraBackupFolder[];
  history: BackupRecord[];
  destinationConnected: boolean;
  /** "Validar o backup do banco restaurando em outro projeto". */
  restoreCheck: RestoreCheckView;
}

// ---------------------------------------------------------------------------
// Teste de restauração (valida o backup do banco restaurando em outro projeto)
// ---------------------------------------------------------------------------

export const RESTORE_CHECK_FREQUENCIES = ["each", "daily", "weekly"] as const;
/** each = após cada backup; daily/weekly = no máximo uma vez por dia/semana. */
export type RestoreCheckFrequency = (typeof RESTORE_CHECK_FREQUENCIES)[number];
export type RestoreCheckStatus = "ok" | "failed" | "not_run" | "running";

/**
 * Por que o teste não rodou, ou falhou, em um código estável (a tela traduz;
 * `reason` é o mesmo texto em português, com o detalhe curto).
 */
export type RestoreCheckReasonCode =
  | "source_no_database"
  | "destination_missing"
  | "destination_renamed"
  | "destination_no_database"
  | "destination_chain"
  | "turned_off"
  | "destination_not_running"
  | "destination_busy"
  | "engine_mismatch"
  | "no_backup"
  | "backup_incomplete"
  | "no_password"
  | "no_database_in_backup"
  | "ambiguous_database"
  | "no_space"
  | "timeout"
  | "panel_restarted"
  | "restart_before_start"
  | "settings_changed"
  | "cleanup_failed"
  | "restore_failed"
  | "sanity_failed"
  | "backup_unreadable";

export interface RestoreCheckSettings {
  enabled: boolean;
  destinationId: string;
  /** Nome do destino quando a pessoa confirmou; se mudar, a opção se desliga. */
  destinationName: string;
  frequency: RestoreCheckFrequency;
}

export interface RestoreCheckResult {
  status: RestoreCheckStatus;
  trigger: "auto" | "manual";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  destinationId: string;
  destinationName: string;
  /** Backup usado (nome do arquivo). */
  backupFileName: string | null;
  reasonCode: RestoreCheckReasonCode | null;
  /** Motivo curto em português, sem dados do banco. */
  reason: string | null;
  /** O que a conferência encontrou no banco restaurado (só números): tabelas e linhas. Só quando o resultado é ok. */
  checked: { tables: number; rows: number } | null;
  /** Registro de histórico desta execução. */
  recordId: string | null;
}

export interface RestoreCheckCandidate {
  id: string;
  name: string;
  engine: BackupDatabaseEngine;
}

/** Por que a opção não está disponível no projeto de origem (a tela traduz; `unavailableReason` é o texto em português). */
export type RestoreCheckUnavailableCode = "undetected" | "no_database" | "not_selected" | "is_destination";

export interface RestoreCheckView {
  /** Configuração guardada (ligada ou não). */
  settings: RestoreCheckSettings | null;
  last: RestoreCheckResult | null;
  /** Não dá para usar a opção neste projeto (motivo); null = disponível. */
  unavailableReason: string | null;
  unavailableCode: RestoreCheckUnavailableCode | null;
  /** Motor do banco do projeto (quando há). */
  engine: BackupDatabaseEngine | null;
  /** Projetos que podem ser o destino: outro projeto, mesmo motor, com banco. */
  candidates: RestoreCheckCandidate[];
  /** A opção foi desligada pelo painel (destino apagado ou renomeado): aviso para a pessoa. */
  notice: { code: "destination_missing" | "destination_renamed"; text: string; at: string } | null;
}

export interface RestoreCheckSettingsRequest {
  enabled: boolean;
  destinationId?: string;
  frequency?: RestoreCheckFrequency;
  /** Nome do projeto de destino digitado (obrigatório ao ligar ou trocar o destino). */
  confirm?: string;
}

export interface RestoreCheckRunRequest {
  /** Nome do projeto de destino digitado. */
  confirm: string;
}

/** Um backup disponível para restaurar. */
export interface BackupPoint {
  fileName: string;
  at: string;
  sizeBytes: number | null;
  local: boolean;
  remote: boolean;
}

/** "Restaurar de outro servidor": o que existe no armazenamento. */
export interface BackupCatalog {
  panel: BackupPoint[];
  email: BackupPoint[];
  projects: Array<{ folder: string; projectId: string | null; projectName: string | null; points: BackupPoint[] }>;
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

export interface BackupDestinationRequest {
  provider: BackupProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  /** Vazio ao editar = manter a chave secreta guardada. */
  secretAccessKey?: string;
}

export interface BackupPasswordRequest {
  password: string;
  acknowledged: boolean;
}

export interface BackupTargetSettingsRequest {
  enabled?: boolean;
  frequencyHours?: BackupFrequencyHours;
  localKeep?: number;
  remoteKeep?: number;
  choices?: Record<string, boolean>;
  extraFolders?: Array<{ service: string; path: string }>;
}

/** "Padrão dos projetos" (só frequência, cópias e ligado/desligado). */
export interface BackupDefaultsRequest {
  enabled?: boolean;
  frequencyHours?: BackupFrequencyHours;
  localKeep?: number;
  remoteKeep?: number;
}

/** "Aplicar também nestes projetos". */
export interface BackupApplyDefaultsRequest {
  projectIds: string[];
}

export interface BackupApplyDefaultsResult {
  applied: Array<{ id: string; name: string }>;
  /** Ids que não são de nenhum projeto. */
  missing: string[];
}

export interface BackupRestoreRequest {
  fileName: string;
  source: "local" | "remote";
  /** O nome do item digitado pela pessoa (confirmação). */
  confirm: string;
  /** Projeto sem containers (VPS nova): publica do GitHub antes de restaurar. */
  redeploy?: boolean;
}

// ---------------------------------------------------------------------------
// Kit de recuperação
// ---------------------------------------------------------------------------

export interface RecoveryKitInput {
  password: string;
  generatedAt: Date;
  destination: { provider: BackupProvider; endpoint: string; bucket: string } | null;
  /** Onde ficam as cópias na VPS (caminho no servidor). */
  localPath: string;
}

/** Arquivo .txt com a senha, onde os backups ficam e como restaurar. */
export function buildRecoveryKit(input: RecoveryKitInput): string {
  const d = input.destination;
  const where = d
    ? d.provider === "r2"
      ? `Cloudflare R2 — bucket "${d.bucket}" (${d.endpoint})`
      : `armazenamento compatível com S3 — bucket "${d.bucket}" (${d.endpoint})`
    : "armazenamento externo ainda não conectado";
  const lines = [
    "TWS Panel — kit de recuperação dos backups",
    `Gerado em ${input.generatedAt.toLocaleString("pt-BR")}`,
    "",
    "GUARDE ESTE ARQUIVO EM LUGAR SEGURO (gerenciador de senhas, pendrive guardado ou impresso).",
    "Sem esta senha, ninguém, nem a TWS, consegue abrir seus backups externos.",
    "Quem tiver esta senha e acesso ao seu armazenamento consegue abri-los.",
    "",
    "SENHA DOS BACKUPS",
    `  ${input.password}`,
    "",
    "Se você trocar a senha no painel, os backups novos usam a nova e os antigos continuam com esta.",
    "",
    "O QUE ESTE KIT NÃO TEM",
    "- As chaves de acesso ao armazenamento (Access Key ID e Secret Access Key). Elas NÃO estão neste arquivo, de propósito:",
    "  quem tem o kit e as chaves chega aos seus backups. Guarde-as à parte, num gerenciador de senhas.",
    "- Numa VPS nova você precisa das DUAS coisas: a senha acima e as chaves de acesso. Sem as chaves não dá para baixar nada.",
    "- Perdeu as chaves? Crie um token novo para o mesmo bucket no provedor (no Cloudflare: R2 → Manage API tokens).",
    "  Os arquivos já guardados continuam legíveis com o token novo.",
    "",
    "ONDE OS BACKUPS FICAM",
    `- Cópia externa (com a senha acima): ${where}`,
    `  - ${BACKUP_ROOT_FOLDER}/_painel/  o painel (contas, projetos cadastrados, configurações e chaves)`,
    `  - ${BACKUP_ROOT_FOLDER}/_email/   o e-mail (caixas, mensagens, contas, regras e chaves DKIM)`,
    `  - ${BACKUP_ROOT_FOLDER}/<projeto>/  bancos de dados e arquivos de cada projeto`,
    "  - Cada arquivo tem o nome AAAA-MM-DD_HH-MM.7z (data e hora do backup no horário da VPS).",
    `- Cópia na VPS (sem senha, as mais recentes): ${input.localPath}`,
    "",
    "RESTAURAR COM O PAINEL",
    "1. Projeto: abra o projeto → aba Backups → Restaurar, escolha a data e confirme digitando o nome do projeto.",
    "2. Painel ou e-mail: Configurações → Backups → Restaurar.",
    "",
    "RESTAURAR NUMA VPS NOVA",
    "1. Instale o TWS Panel na VPS nova (scripts/install.sh) e conclua o assistente de instalação.",
    "2. Em Configurações → Backups, clique em Restaurar de outro servidor.",
    "3. Informe o mesmo armazenamento: o endpoint e o bucket estão acima; as chaves de acesso você guardou à parte (não estão neste kit).",
    "   Depois informe esta senha. As chaves que você digitar na VPS nova continuam valendo depois de restaurar o painel.",
    "4. Restaure primeiro o painel. Ele reinicia; entre de novo com o usuário e a senha do painel antigo.",
    "5. Depois restaure cada projeto, marcando a publicação antes (o painel publica o projeto: do GitHub, ou a partir do código que estava no backup, nos projetos de upload e de pasta do servidor; depois põe os dados de volta) e o e-mail.",
    "6. Aponte o DNS (registros A, MX e o PTR no provedor) para o IP da VPS nova.",
    "",
    "RESTAURAR SEM O PAINEL",
    "1. Baixe o arquivo .7z do armazenamento (no Cloudflare: R2 → seu bucket → o arquivo → Download).",
    "2. Abra com o 7-Zip (Windows, 7-zip.org) ou o Keka (Mac). Ele pede a senha acima.",
    "   No Linux: 7z x AAAA-MM-DD_HH-MM.7z   (ou 7zz x …)",
    "3. Dentro há um LEIA-ME.txt explicando cada arquivo:",
    "   - bancos/: os dumps dos bancos (.sql ou .archive), arquivos comuns.",
    "   - volumes/ e pastas/: arquivos .tar com o conteúdo de cada pasta.",
    "4. PostgreSQL: psql -U <usuário> -d <banco> < bancos/<serviço>/<banco>.sql",
    "   MySQL/MariaDB: mysql -u root -p < bancos/<serviço>.sql",
    "   MongoDB: mongorestore --archive=bancos/<serviço>.archive --drop",
    "   Pastas: tar -xf volumes/<nome>.tar -C <pasta de destino>",
    "5. Painel: o conteúdo do arquivo é o diretório de dados (/data do container tws-panel).",
    "   Na VPS: sudo bash scripts/restaurar-painel.sh <arquivo.7z>",
    "",
  ];
  return lines.join("\n");
}
