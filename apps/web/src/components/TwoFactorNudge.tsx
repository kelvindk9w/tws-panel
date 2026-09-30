import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { TwoFactorStatusResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

/**
 * Aviso do Dashboard enquanto a verificação em duas etapas estiver desligada:
 * com o acesso por HTTPS, o painel fica na internet e só a senha o protege.
 * Sem resposta do servidor, não afirma nada (não aparece).
 */
export function TwoFactorNudge() {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    apiFetch<TwoFactorStatusResponse>("/api/auth/2fa")
      .then((s) => setEnabled(typeof s?.enabled === "boolean" ? s.enabled : null))
      .catch(() => setEnabled(null));
  }, []);

  if (enabled !== false) return null;
  return (
    <div
      data-testid="two-factor-nudge"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      <span className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          O painel está na internet e protegido só pela senha. Ative a <strong>verificação em duas etapas</strong>:
          entrar passa a exigir também um código do seu celular.
        </span>
      </span>
      <Button size="sm" asChild>
        <Link to="/settings/security#two-factor">Ativar agora</Link>
      </Button>
    </div>
  );
}
