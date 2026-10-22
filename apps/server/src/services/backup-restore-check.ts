/**
 * backup-restore-check.ts — regras puras do "teste de restauração": validar o
 * backup do banco de um projeto restaurando-o no banco de OUTRO projeto (o de
 * teste/desenvolvimento). A fila, o Docker e o estado em disco ficam no
 * backup-service.ts; aqui só o que decide e o que diz.
 *
 * Princípios (a prova é feita num banco TEMPORÁRIO no servidor do destino; ver
 * backup-restore-validate.ts):
 *  - só o dump do banco; nunca volumes, arquivos, código, .env, variáveis ou e-mail;
 *  - nada do que já existe no destino é alterado: nem seus bancos, nem usuários
 *    ou papéis (o dump de papéis do Postgres leva o hash da senha da origem);
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
  no_backup: "Ainda não há backup deste projeto para testar.",
  backup_incomplete: "O backup ficou incompleto e não é usado no teste.",
  no_password: "O backup está cifrado e o painel não tem a senha dele.",
  no_database_in_backup: "O backup não tem banco do mesmo tipo que o do destino.",
  ambiguous_database: "Não foi possível saber qual banco do backup é o principal.",
  no_space: "Não há espaço em disco para abrir o backup.",
  timeout: "A restauração passou do prazo e foi interrompida. O banco temporário do teste foi apagado.",
  panel_restarted: "O painel reiniciou durante o teste. Um banco temporário (tws_rc_) pode ter ficado no servidor do destino; o próximo teste o apaga.",
  restart_before_start: "O painel reiniciou antes de o teste começar. Ele não rodou.",
  settings_changed: "O destino do teste foi trocado antes de ele começar. Este pedido não rodou.",
  restore_failed: "A restauração do backup num banco temporário do destino falhou: o backup pode estar com defeito, ou o servidor do destino não aceita algo do dump (extensão, permissão). O banco temporário foi apagado.",
  sanity_failed: "O backup não passou na conferência: está incompleto, ou o que foi restaurado não bate com o que o backup tem.",
  cleanup_failed: "O teste terminou, mas não foi possível apagar o banco temporário (tws_rc_) do servidor do destino. Apague-o à mão; o próximo teste também tenta.",
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

/** Janela mínima entre testes automáticos (ms); 0 = após cada backup. */
export function frequencyWindowMs(frequency: "each" | "daily" | "weekly"): number {
  return frequency === "daily" ? 24 * 3_600_000 : frequency === "weekly" ? 7 * 24 * 3_600_000 : 0;
}
