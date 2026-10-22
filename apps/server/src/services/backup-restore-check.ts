/**
 * backup-restore-check.ts — regras puras do "teste de restauração": validar o
 * backup do banco de um projeto restaurando-o no banco de OUTRO projeto (o de
 * teste/desenvolvimento). A fila, o Docker e o estado em disco ficam no
 * backup-service.ts; aqui só o que decide e o que diz.
 *
 * Princípios (o destino é APAGADO e recriado no que o backup tem):
 *  - só o dump do banco; nunca volumes, arquivos, código, .env, variáveis ou e-mail;
 *  - nunca os papéis (usuários) do Postgres: o dump deles leva o hash da senha do
 *    projeto de origem e trocaria as credenciais do banco do destino;
 *  - o motivo guardado é um código + um texto fixo: nada que o banco devolva
 *    (mensagens de erro podem citar valores de linhas) vai para tela, log ou auditoria.
 */
import type { BackupDatabaseEngine, DetectedDatabase, RestoreCheckReasonCode } from "@paas/core";

/** Texto fixo, em português, de cada motivo (a tela traduz pelo código). */
export const RESTORE_CHECK_REASONS: Readonly<Record<RestoreCheckReasonCode, string>> = {
  source_no_database: "Este projeto não tem um banco de dados que o backup copie.",
  destination_missing: "O projeto de destino não existe mais.",
  destination_renamed: "O projeto de destino foi renomeado desde que você confirmou.",
  destination_no_database: "O projeto de destino não tem banco de dados detectado.",
  destination_not_running: "O banco do projeto de destino não está em execução. O painel não liga nada para o teste.",
  destination_busy: "O projeto de destino está em deploy ou em outra operação.",
  destination_chain: "O projeto de destino tem um teste de restauração próprio ligado. O painel nunca restaura em cima de um projeto que também é origem de teste.",
  engine_mismatch: "O banco do destino é de outro tipo que o do projeto de origem.",
  database_name_mismatch: "O banco do destino tem outro nome, e este tipo de banco é recriado com o nome do backup.",
  no_backup: "Ainda não há backup deste projeto para testar.",
  backup_incomplete: "O backup ficou incompleto e não é usado no teste.",
  no_password: "O backup está cifrado e o painel não tem a senha dele.",
  no_database_in_backup: "O backup não tem banco do mesmo tipo que o do destino.",
  ambiguous_database: "Não foi possível saber qual banco do backup é o principal.",
  no_space: "Não há espaço em disco para abrir o backup.",
  timeout: "A restauração passou do prazo e foi interrompida. O banco de teste pode estar incompleto.",
  panel_restarted: "O painel reiniciou durante o teste. O banco de teste pode estar incompleto.",
  restore_failed: "A restauração do banco falhou. O banco de teste pode estar incompleto.",
  sanity_failed: "A restauração terminou, mas o banco do destino ficou sem tabelas, ou não foi possível conferir. O banco de teste pode estar incompleto.",
  backup_unreadable: "Não foi possível abrir o backup (arquivo ausente, corrompido ou alterado).",
  turned_off: "A opção foi desligada antes de o teste começar.",
};

/** Motores que o teste sabe restaurar (o Redis é cache: fica de fora). */
export function isRestorable(engine: BackupDatabaseEngine): boolean {
  return engine !== "redis";
}

/** Primeiro banco restaurável de uma lista detectada. */
export function firstRestorable(dbs: DetectedDatabase[]): DetectedDatabase | null {
  return dbs.find((d) => isRestorable(d.engine)) ?? null;
}

/**
 * O Postgres é restaurado DENTRO do banco do destino (o nome é trocado). MySQL,
 * MariaDB e MongoDB recriam o banco com o nome que está no dump: se os nomes
 * conhecidos diferem, o teste apagaria outro banco do servidor do destino (ou
 * criaria um ao lado, sem validar o do projeto): não é elegível.
 */
export function databaseNamesCompatible(engine: BackupDatabaseEngine, source: string | null, dest: string | null): boolean {
  if (engine === "postgres") return true;
  if (source === null || dest === null) return true;
  return source === dest;
}

/** Quantas linhas de erro do banco a restauração devolveu (só a contagem; o texto nunca é guardado). */
export function countDbErrors(stderr: string, engine: BackupDatabaseEngine): number {
  const re = engine === "postgres" ? /ERROR:/ : /ERROR/;
  return stderr.split("\n").filter((l) => re.test(l)).length;
}

/** Janela mínima entre testes automáticos (ms); 0 = após cada backup. */
export function frequencyWindowMs(frequency: "each" | "daily" | "weekly"): number {
  return frequency === "daily" ? 24 * 3_600_000 : frequency === "weekly" ? 7 * 24 * 3_600_000 : 0;
}
