import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiRequestError, apiFetch, clearSetupToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { apiErrorText, useI18n } from "@/i18n";
import { ChevronDown, KeyRound, LogOut, Settings, ShieldCheck, UserRound } from "lucide-react";

/**
 * Menu do usuário: atalhos para Configurações (a conta mora lá) e sair.
 * O idioma não fica aqui: o seletor está sempre à vista no cabeçalho (Layout).
 * No topo abre para baixo; na lateral (Configurações → Aparência), fica no
 * rodapé dela e abre para cima.
 *
 * "Sair" só leva ao login quando o servidor confirma o fim da sessão. Se a
 * revogação falha (ex.: 500 storage_write_failed, disco do servidor), a sessão
 * e o cookie continuam valendo: o menu fica aberto com o erro e um botão para
 * tentar de novo, em vez de parecer que saiu. 401 = a sessão já não valia, e
 * aí ir para o login é verdade.
 */
export function UserMenu({ placement = "top" }: { placement?: "top" | "sidebar-left" | "sidebar-right" }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // fecha o menu ao clicar fora
  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setLogoutError(null);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function logout() {
    setLeaving(true);
    setLogoutError(null);
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.status === 401)) {
        const detail = err instanceof ApiRequestError ? apiErrorText(err, "shell.userMenu.unexpectedError") : t("shell.userMenu.unexpectedError");
        setLogoutError(detail);
        setLeaving(false);
        return;
      }
    }
    clearSetupToken();
    navigate("/login");
  }

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent";

  function close() {
    setOpen(false);
    setLogoutError(null);
  }

  return (
    <div
      ref={containerRef}
      className={placement === "top" ? "relative" : "relative w-full"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
          buttonRef.current?.focus();
        }
      }}
      onBlur={(event) => {
        // o foco foi para fora do menu (ex.: abriu o submenu de Configurações): fecha, sem sobrepor
        const to = event.relatedTarget as Node | null;
        if (to && containerRef.current && !containerRef.current.contains(to)) close();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("shell.userMenu.account", { name: user.displayName || user.username })}
        title={user.displayName || user.username}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1.5 sm:gap-2 sm:px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          placement !== "top" && "w-full",
        )}
      >
        <UserRound className="h-4 w-4" />
        {/* no topo, em tela de celular, só o ícone: o nome empurrava a página para o lado */}
        <span className={cn("truncate", placement === "top" ? "hidden max-w-24 sm:inline lg:max-w-16 xl:max-w-32" : "flex-1 text-left")}>
          {user.displayName || user.username}
        </span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-50 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
            placement === "top" && "right-0 top-full mt-1",
            placement === "sidebar-left" && "bottom-full left-0 mb-1",
            // à direita da tela a caixa abre para dentro, senão passaria da borda
            placement === "sidebar-right" && "bottom-full right-0 mb-1",
          )}
        >
          <button type="button" className={item} onClick={() => go("/settings")}>
            <Settings className="h-4 w-4" /> {t("shell.userMenu.settings")}
          </button>
          <button type="button" className={item} onClick={() => go("/settings/security")}>
            <KeyRound className="h-4 w-4" /> {t("shell.userMenu.changePassword")}
          </button>
          <button type="button" className={item} onClick={() => go("/settings/security#two-factor")}>
            <ShieldCheck className="h-4 w-4" /> {t("shell.userMenu.twoFactor")}
          </button>
          {logoutError ? (
            <div role="alert" className="m-1 rounded-sm border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              <p>
                <strong>{t("shell.userMenu.stillSignedIn")}</strong> {t("shell.userMenu.logoutUnconfirmed", { detail: logoutError })}
              </p>
              <button
                type="button"
                disabled={leaving}
                className={cn(item, "mt-1 text-red-400")}
                onClick={() => void logout()}
              >
                <LogOut className="h-4 w-4" /> {t("shell.userMenu.retryLogout")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={leaving}
              className={cn(item, "text-red-400")}
              onClick={() => void logout()}
            >
              <LogOut className="h-4 w-4" /> {leaving ? t("shell.userMenu.signingOut") : t("shell.userMenu.signOut")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
