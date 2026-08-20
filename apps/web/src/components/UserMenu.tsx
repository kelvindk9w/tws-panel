import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
  type ChangePasswordRequest,
} from "@paas/core";
import { apiFetch, ApiRequestError, clearSetupToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, ChevronDown, Circle, KeyRound, Loader2, LogOut, UserRound, X } from "lucide-react";

/** Modal de troca de senha (exige a senha atual; invalida as demais sessões). */
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const strength = validatePasswordStrength(newPassword);
  const canSubmit =
    currentPassword.length > 0 && strength.valid && confirm === newPassword && !loading;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const payload: ChangePasswordRequest = { currentPassword, newPassword };
      await apiFetch("/api/auth/change-password", { method: "POST", body: JSON.stringify(payload) });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível trocar a senha.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            <KeyRound className="h-4 w-4" /> Trocar senha
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            <p className="text-sm">
              Senha alterada com sucesso. As outras sessões foram encerradas.
            </p>
            <Button onClick={onClose} className="mt-2">Fechar</Button>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cp-current" className="text-sm font-medium">Senha atual</label>
              <Input
                id="cp-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cp-new" className="text-sm font-medium">Nova senha</label>
              <Input
                id="cp-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              {newPassword.length > 0 && (
                <ul className="flex flex-col gap-1 text-xs">
                  <li className={`flex items-center gap-1.5 ${strength.checks.minLength ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {strength.checks.minLength ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                    Mínimo de {PASSWORD_MIN_LENGTH} caracteres
                  </li>
                  <li className={`flex items-center gap-1.5 ${strength.checks.hasUpper && strength.checks.hasLower ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {strength.checks.hasUpper && strength.checks.hasLower ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                    Maiúsculas e minúsculas
                  </li>
                  <li className={`flex items-center gap-1.5 ${strength.checks.hasNumber ? "text-emerald-400" : "text-muted-foreground"}`}>
                    {strength.checks.hasNumber ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5" />}
                    Ao menos um número
                  </li>
                </ul>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="cp-confirm" className="text-sm font-medium">Confirmar nova senha</label>
              <Input
                id="cp-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm.length > 0 && confirm !== newPassword && (
                <p className="text-xs text-amber-400">As senhas não coincidem.</p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={!canSubmit}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Salvando…" : "Salvar nova senha"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Menu do usuário no header: troca de senha e logout. */
export function UserMenu() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // fecha o menu ao clicar fora
  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch {
      // best-effort: mesmo falhando, segue para o login
    }
    clearSetupToken();
    navigate("/login");
  }

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <UserRound className="h-4 w-4" />
        <span className="max-w-32 truncate">{user.username}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false);
              setShowChangePassword(true);
            }}
          >
            <KeyRound className="h-4 w-4" /> Trocar senha
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-red-400 hover:bg-accent"
            onClick={() => void logout()}
          >
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </div>
      )}

      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
    </div>
  );
}
