import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";
import { Bell, Palette, ShieldCheck, UserRound } from "lucide-react";

/** Seções de Configurações — cada uma com o seu endereço. */
export const SETTINGS_SECTIONS = [
  { to: "/settings/profile", label: "Perfil", icon: UserRound },
  { to: "/settings/security", label: "Segurança", icon: ShieldCheck },
  { to: "/settings/appearance", label: "Aparência", icon: Palette },
  { to: "/settings/notifications", label: "Notificações", icon: Bell },
] as const;

/**
 * Casca de Configurações: menu próprio das seções (coluna à esquerda em telas
 * largas, faixa rolável no alto em telas pequenas) + a seção aberta.
 */
export function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">Ajustes da sua conta e do painel.</p>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav
          data-testid="settings-nav"
          aria-label="Seções de configurações"
          className="flex shrink-0 gap-1 overflow-x-auto text-sm md:w-48 md:flex-col"
        >
          {SETTINGS_SECTIONS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors",
                  isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
