import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch, clearSetupToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { ChevronDown, KeyRound, LogOut, Settings, ShieldCheck, UserRound } from "lucide-react";

/**
 * Menu do usuário: atalhos para Configurações (a conta mora lá) e sair.
 * No topo abre para baixo; na lateral (Configurações → Aparência), fica no
 * rodapé dela e abre para cima.
 */
export function UserMenu({ placement = "top" }: { placement?: "top" | "sidebar-left" | "sidebar-right" }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent";

  return (
    <div ref={containerRef} className={placement === "top" ? "relative ml-auto" : "relative w-full"}>
      <button
        type="button"
        aria-label={`Conta: ${user.displayName || user.username}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          placement !== "top" && "w-full",
        )}
      >
        <UserRound className="h-4 w-4" />
        {/* no topo, em tela de celular, só o ícone: o nome empurrava a página para o lado */}
        <span className={cn("truncate", placement === "top" ? "hidden max-w-32 sm:inline" : "flex-1 text-left")}>
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
            <Settings className="h-4 w-4" /> Configurações
          </button>
          <button type="button" className={item} onClick={() => go("/settings/security")}>
            <KeyRound className="h-4 w-4" /> Trocar senha
          </button>
          <button type="button" className={item} onClick={() => go("/settings/security#two-factor")}>
            <ShieldCheck className="h-4 w-4" /> Verificação em duas etapas
          </button>
          <button type="button" className={cn(item, "text-red-400")} onClick={() => void logout()}>
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </div>
      )}
    </div>
  );
}
