/**
 * Reconciliação depois de restaurar um backup: o que o painel antigo tinha
 * ATIVO e não está rodando nesta VPS. O painel só informa e oferece a ação
 * (ativar webmail ou e-mail mexe em portas, DNS e certificados): nada sobe
 * sozinho. Ver apps/server/src/services/restore-reconciliation.ts.
 */

/** O que pode ficar pendente. */
export const RECONCILIATION_IDS = ["webmail", "mail-server", "panel-domain", "mail-auth"] as const;
export type ReconciliationId = (typeof RECONCILIATION_IDS)[number];

/**
 * pending = estava ativo no backup e não está rodando aqui;
 * unknown = não deu para conferir agora (Docker ou DNS sem resposta): o
 * aviso continua até conferir ou dispensar.
 */
export type ReconciliationStatus = "pending" | "unknown";

export interface ReconciliationItem {
  id: ReconciliationId;
  status: ReconciliationStatus;
  /** De onde veio a pendência: restauração do painel ou do e-mail. */
  source: "panel" | "email";
  /** Quando a pendência foi criada (ISO). */
  since: string;
}

export interface ReconciliationResponse {
  items: ReconciliationItem[];
}
