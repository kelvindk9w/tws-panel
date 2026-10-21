import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { ReconciliationId, ReconciliationItem, ReconciliationResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2 } from "lucide-react";

/** De quanto em quanto tempo a lista é conferida de novo (a aba visível também confere ao voltar o foco). */
const REFRESH_MS = 30_000;

const COPY = {
  webmail: { key: "webmail", to: "/mail" },
  "mail-server": { key: "mailServer", to: "/mail" },
  "panel-domain": { key: "panelDomain", to: "/settings/panel-domain" },
  "mail-auth": { key: "mailAuth", to: null },
} as const satisfies Record<ReconciliationId, { key: string; to: string | null }>;

/**
 * Aviso âmbar (não é erro) depois de restaurar um backup: "O painel antigo
 * tinha X ativo. Ativar agora?". O painel só pergunta e leva à ação de sempre
 * (E-mail, Domínio do painel); nada é ligado sozinho. Some quando o serviço
 * passa a rodar e quando não há nada pendente. Aparece no Dashboard e no
 * resultado da restauração (`variant="result"`).
 *
 * Acessível: role="status", ícone + título (não só cor), cada pendência é uma
 * nota própria e os botões têm nome.
 */
export function ReconciliationNotice({ variant = "dashboard" }: { variant?: "dashboard" | "result" } = {}) {
  const { t } = useI18n();
  const [items, setItems] = useState<ReconciliationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReconciliationId | null>(null);
  const [confirmRepair, setConfirmRepair] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<ReconciliationResponse>("/api/restore-reconciliation");
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch {
      // sem resposta (ou sessão acabada): não inventa aviso
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  async function dismiss(id: ReconciliationId) {
    setBusy(id);
    setError(null);
    try {
      const res = await apiFetch<ReconciliationResponse>(`/api/restore-reconciliation/${id}/dismiss`, { method: "POST" });
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      setError(apiErrorText(err, "backups.reconcile.actionError"));
    } finally {
      setBusy(null);
    }
  }

  async function repair() {
    setBusy("mail-auth");
    setError(null);
    try {
      await apiFetch("/api/mail/server/repair-auth", { method: "POST" });
      setConfirmRepair(false);
      await load();
    } catch (err) {
      setError(apiErrorText(err, "backups.reconcile.actionError"));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;
  return (
    <div
      data-testid="restore-reconciliation"
      data-variant={variant}
      role="status"
      className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> {t("backups.reconcile.heading")}
      </p>
      {items.map((item) => {
        const copy = COPY[item.id];
        const isRepair = item.id === "mail-auth";
        return (
          <div key={item.id} role="note" className="flex flex-col gap-2 border-t border-amber-500/20 pt-3 first-of-type:border-t-0 first-of-type:pt-0">
            <p className="font-medium">{t(`backups.reconcile.${copy.key}.question`)}</p>
            <p className="text-amber-200/80">{item.status === "unknown" ? t("backups.reconcile.unknown") : t(`backups.reconcile.${copy.key}.detail`)}</p>
            <div className="flex flex-wrap items-center gap-2">
              {copy.to && (
                <Button size="sm" asChild>
                  <Link to={copy.to}>{t(`backups.reconcile.${copy.key}.cta`)}</Link>
                </Button>
              )}
              {isRepair &&
                (confirmRepair ? (
                  <>
                    <span>{t("backups.reconcile.mailAuth.confirmText")}</span>
                    <Button size="sm" disabled={busy !== null} onClick={() => void repair()}>
                      {busy === "mail-auth" && <Loader2 className="h-4 w-4 animate-spin" />}
                      {busy === "mail-auth" ? t("backups.reconcile.mailAuth.working") : t("backups.reconcile.mailAuth.confirm")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRepair(false)}>
                      {t("backups.reconcile.mailAuth.cancel")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => setConfirmRepair(true)}>
                    {t("backups.reconcile.mailAuth.cta")}
                  </Button>
                ))}
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void dismiss(item.id)}>
                {t("backups.reconcile.dismiss")}
              </Button>
            </div>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
