import { NavLink, Outlet } from "react-router";
import { cn } from "@/lib/utils";
import { t, useI18n, type Key } from "@/i18n";
import {
  Activity,
  Bell,
  Bot,
  Clock,
  Database,
  DatabaseBackup,
  KeyRound,
  Globe,
  Network,
  ListChecks,
  Palette,
  Plug,
  ShieldCheck,
  UserRound,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

function section<const T extends { to: string; labelKey: Key; icon: LucideIcon }>(s: T) {
  return {
    ...s,
    /** Rótulo no idioma atual (lido na hora do acesso). */
    get label(): string {
      return t(s.labelKey);
    },
  };
}

/** Seções de Configurações — cada uma com o seu endereço. */
export const SETTINGS_SECTIONS = [
  section({ to: "/settings/profile", labelKey: "settings.section.profile", icon: UserRound }),
  section({ to: "/settings/security", labelKey: "settings.section.security", icon: ShieldCheck }),
  section({ to: "/settings/access", labelKey: "settings.section.access", icon: KeyRound }),
  section({ to: "/settings/panel-domain", labelKey: "settings.section.panelDomain", icon: Globe }),
  section({ to: "/settings/apps-domain", labelKey: "settings.section.appsDomain", icon: Network }),
  section({ to: "/settings/dynamic-domains", labelKey: "settings.section.dynamicDomains", icon: Waypoints }),
  section({ to: "/settings/appearance", labelKey: "settings.section.appearance", icon: Palette }),
  section({ to: "/settings/notifications", labelKey: "settings.section.notifications", icon: Bell }),
  section({ to: "/settings/backups", labelKey: "settings.section.backups", icon: DatabaseBackup }),
  section({ to: "/settings/timezone", labelKey: "settings.section.timezone", icon: Clock }),
  section({ to: "/settings/integrations", labelKey: "settings.section.integrations", icon: Plug }),
  section({ to: "/settings/metrics", labelKey: "settings.section.metrics", icon: Activity }),
  section({ to: "/settings/database", labelKey: "settings.section.database", icon: Database }),
  section({ to: "/settings/api-access", labelKey: "settings.section.apiAccess", icon: Bot }),
  section({ to: "/settings/onboarding", labelKey: "settings.section.onboarding", icon: ListChecks }),
] as const;

/**
 * Casca de Configurações: menu próprio das seções (coluna à esquerda em telas
 * largas, faixa rolável no alto em telas pequenas) + a seção aberta.
 */
export function SettingsLayout() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.layout.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.layout.subtitle")}</p>
      </div>
      <div className="flex flex-col gap-6 md:flex-row">
        <nav
          data-testid="settings-nav"
          aria-label={t("settings.layout.navLabel")}
          className="flex shrink-0 gap-1 overflow-x-auto text-sm md:w-48 md:flex-col"
        >
          {SETTINGS_SECTIONS.map(({ to, labelKey, icon: Icon }) => (
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
              <Icon className="h-4 w-4" /> {t(labelKey)}
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
