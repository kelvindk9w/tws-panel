/**
 * backup-restore-check.ts — regras puras do "teste de restauração": provar que
 * o backup de um projeto restaura, numa cópia DESCARTÁVEL (um container novo da
 * mesma imagem do banco do projeto, sem rede, sem volumes do projeto, com limite
 * de memória, CPU e tempo, removido no fim). A fila, o Docker e o estado em disco
 * ficam no backup-service.ts; a restauração em si, no backup-restore-validate.ts.
 * Aqui só o que decide e o que diz.
 *
 * Princípios:
 *  - nada do projeto é tocado: nem os containers, nem os volumes, nem as redes;
 *  - volumes, pastas e código não são restaurados em lugar nenhum: os .tar são
 *    só listados (e o .7z inteiro é testado, com o CRC de cada arquivo);
 *  - o motivo guardado é um código + um texto fixo: nada que o banco devolva
 *    (mensagens de erro podem citar valores de linhas) vai para tela, log ou auditoria.
 */
import type { BackupDatabaseEngine, DetectedDatabase, RestoreCheckReasonCode } from "@paas/core";

/** Texto fixo, em português, de cada motivo (a tela traduz pelo código). */
export const RESTORE_CHECK_REASONS: Readonly<Record<RestoreCheckReasonCode, string>> = {
  turned_off: "A opção foi desligada antes de o teste começar.",
  nothing_to_check: "O backup não tem banco de dados nem arquivos de volumes, pastas ou código para conferir.",
  // só em resultados de versões anteriores: o teste não reserva mais o projeto
  project_busy: "O projeto continuou em deploy (ou em outra operação) e o teste não rodou. Nada foi alterado.",
  image_unavailable: "A imagem do banco do projeto não está nesta VPS (o container do banco não existe). O painel não baixa imagens para o teste; faça o deploy do projeto.",
  sandbox_failed: "O container descartável do teste não ficou pronto a tempo (ou parou sozinho), então o teste não rodou. A imagem do banco pode precisar de variáveis próprias para subir.",
  no_backup: "Ainda não há backup deste projeto para testar.",
  backup_incomplete: "O backup ficou incompleto e não é usado no teste.",
  no_password: "O backup está cifrado e o painel não tem a senha dele.",
  ambiguous_database: "Não foi possível saber qual banco do backup é o principal.",
  empty_database: "Nenhum banco do backup tem tabelas (ou coleções): não há o que provar na restauração. Confira se o banco marcado na aba Backups é o que guarda os dados.",
  no_space: "Não há espaço em disco (no servidor ou no disco do Docker) para abrir o backup e restaurar a cópia descartável. O teste não rodou.",
  timeout: "Limite do teste: a restauração passou do prazo e foi interrompida. Isso não indica defeito no backup (pode ser só um banco grande). O container descartável foi removido.",
  panel_restarted: "O painel reiniciou durante o teste. O container descartável (tws-rc-) que sobrou é removido ao iniciar e no próximo teste.",
  restart_before_start: "O painel reiniciou antes de o teste começar. Ele não rodou.",
  cleanup_failed: "O teste terminou, mas não foi possível confirmar a remoção do container descartável (tws-rc-). O painel guardou o nome e tenta remover de novo ao iniciar, ao desligar a opção e no próximo teste.",
  unsafe_dump: "O dump tem comandos do cliente psql (barra invertida), que o teste não executa por segurança.",
  restore_failed: "A restauração do banco na cópia descartável falhou: o backup pode estar com defeito. O container descartável foi removido.",
  sanity_failed: "O backup não passou na conferência: está incompleto, ou o que foi restaurado não bate com o que o backup tem.",
  volume_check_failed: "Um arquivo de volume, pasta ou código do backup não pôde ser lido (o .tar está corrompido ou incompleto).",
  backup_unreadable: "Não foi possível abrir o backup (arquivo ausente, corrompido ou alterado).",
  cancelled: "O teste foi cancelado. O container descartável foi removido; nada do projeto foi alterado.",
  memory_limit: "Limite do teste: a cópia descartável passou do limite de memória e o banco foi interrompido. Isso não indica defeito no backup (pode ser só um banco grande). O container descartável foi removido.",
};

/** O código guardado ainda existe? (resultados de versões antigas do painel têm códigos que não existem mais). */
export function isRestoreCheckReason(code: unknown): code is RestoreCheckReasonCode {
  return typeof code === "string" && Object.hasOwn(RESTORE_CHECK_REASONS, code);
}

/** Motores que o teste restaura num container descartável. O Redis é cache: o arquivo dele só é listado, como os volumes. */
export function isRestorable(engine: BackupDatabaseEngine): boolean {
  return engine !== "redis";
}

/** Primeiro banco restaurável de uma lista detectada. */
export function firstRestorable(dbs: DetectedDatabase[]): DetectedDatabase | null {
  return dbs.find((d) => isRestorable(d.engine)) ?? null;
}

/** Códigos que são "não executado" (o teste não provou nada do backup, nem para o bem, nem para o mal): sem alerta de falha. */
export const RESTORE_CHECK_NOT_RUN: ReadonlySet<RestoreCheckReasonCode> = new Set<RestoreCheckReasonCode>([
  "empty_database",
  "image_unavailable",
  "no_space",
  "timeout",
  "memory_limit",
  "cancelled",
  "sandbox_failed",
]);

/** Janela mínima entre testes automáticos (ms); 0 = após cada backup. */
export function frequencyWindowMs(frequency: "each" | "daily" | "weekly"): number {
  return frequency === "daily" ? 24 * 3_600_000 : frequency === "weekly" ? 7 * 24 * 3_600_000 : 0;
}
