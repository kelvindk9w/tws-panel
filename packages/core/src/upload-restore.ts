/**
 * upload-restore.ts — "Restaurar de um arquivo": o dump de banco vem de fora (outro servidor, a máquina de
 * desenvolvimento, uma ferramenta) e é enviado pela aba Backups do projeto. Tipos e constantes compartilhados
 * entre o servidor e a tela. A regra está em apps/server/src/services/upload-restore.ts.
 */
import type { BackupDatabaseEngine } from "./backups";

/** Tamanho máximo padrão de um arquivo enviado (configurável pelo operador: PAAS_UPLOAD_RESTORE_MAX_BYTES). */
export const UPLOAD_RESTORE_DEFAULT_MAX_BYTES = 10 * 1024 ** 3;

/** Extensões que a tela oferece no seletor de arquivo (o formato real é decidido pelos primeiros bytes). */
export const UPLOAD_RESTORE_ACCEPT = ".sql,.gz,.dump,.backup,.archive,.7z";

/** O que o painel reconheceu pelos primeiros bytes do arquivo. */
export type UploadRestoreFormat = "pg_custom" | "sql" | "mongo_archive" | "panel_backup";

export interface UploadRestoreTarget {
  service: string;
  engine: BackupDatabaseEngine;
  /** O container do banco está ligado (restaurar exige). */
  running: boolean;
  /** PostgreSQL e MySQL/MariaDB: os bancos do servidor (vazio se não deu para listar). */
  databases: string[];
  /** Banco principal lido do ambiente do container (nunca a senha). */
  defaultDatabase: string | null;
}

/** GET /api/backups/projects/:id/upload-restore */
export interface UploadRestoreOptions {
  services: UploadRestoreTarget[];
  maxBytes: number;
  /** Espaço livre na pasta de envios (null = não deu para medir). */
  freeBytes: number | null;
  /** Projeto marcado como de desenvolvimento (a tela sugere "sem backup"). */
  development: boolean;
  /** Já existe um envio ou uma restauração em andamento neste projeto. */
  busy: boolean;
}

/** Resposta do envio do arquivo (PUT .../upload-restore/files). */
export interface UploadRestoreUploaded {
  uploadId: string;
  sizeBytes: number;
  format: UploadRestoreFormat;
  gzip: boolean;
  /** Backup do próprio painel (.7z) cifrado cuja senha o painel não tem: peça a senha antes de restaurar. */
  needsPassword: boolean;
}

/** Corpo de POST .../upload-restore/files/:uploadId/check (backup do painel). */
export interface UploadRestoreCheckRequest {
  service: string;
  database?: string;
  password?: string;
}

export interface UploadRestoreCheckResponse {
  ok: true;
  /** Bancos que o backup traz para o serviço pedido. */
  databases: string[];
}

export type UploadRestoreBackupChoice = "none" | "full";

/** Corpo de POST .../upload-restore (começa a restaurar). */
export interface UploadRestoreStartRequest {
  uploadId: string;
  service: string;
  /** PostgreSQL/MySQL: banco de destino (a lista vem de `UploadRestoreTarget.databases`). */
  database?: string;
  /** Limpar o banco antes: `pg_restore --clean --if-exists` (formato personalizado) e `mongorestore --drop`. */
  clean: boolean;
  backup: UploadRestoreBackupChoice;
  /** Nome do projeto, digitado. */
  confirm: string;
  /** Senha do backup do painel (.7z cifrado). Nunca guardada nem auditada. */
  backupPassword?: string;
  currentPassword: string;
  code?: string;
  emailCode?: string;
}

export type UploadRestoreStatus = "validating" | "waiting_backup" | "restoring" | "success" | "failed";

export interface UploadRestoreJob {
  id: string;
  projectId: string;
  service: string;
  engine: BackupDatabaseEngine;
  format: UploadRestoreFormat;
  sizeBytes: number;
  clean: boolean;
  backup: UploadRestoreBackupChoice;
  status: UploadRestoreStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Arquivo do backup feito antes (quando pedido). */
  backupFileName: string | null;
  /** Saída do cliente do banco (limitada). Pode citar trechos do arquivo: só a pessoa vê. */
  output: string | null;
  error: { code: string; message: string } | null;
}
