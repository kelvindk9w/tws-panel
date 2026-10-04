import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { Menu, X } from "lucide-react";
import type { AlertListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/UserMenu";
import { useAuth } from "@/lib/auth";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects/new", label: "Novo Projeto" },
  { to: "/mail", label: "E-mail" },
  { to: "/mail/envios", label: "Envios" },
  { to: "/certificates", label: "Certificados" },
  { to: "/security", label: "Segurança" },
  { to: "/alerts", label: "Alertas" },
  { to: "/audit", label: "Auditoria" },
  { to: "/settings", label: "Configurações" },
  { to: "/setup", label: "Setup" },
];

/** Badge com a contagem de alertas abertos (polling de 30s). */
function OpenAlertsBadge() {
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await apiFetch<AlertListResponse>("/api/alerts?status=open&perPage=1");
        if (!cancelled) setOpenCount(res.openCount);
      } catch {
        // polling best-effort
      }
    }
    void tick();
    // Polling pausado com a aba oculta; retoma (e atualiza) ao voltar.
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer === null && document.visibilityState !== "hidden") {
        timer = setInterval(() => void tick(), 30_000);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
      } else {
        void tick();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  if (openCount === 0) return null;
  return (
    <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
      {openCount > 99 ? "99+" : openCount}
    </span>
  );
}

function Brand() {
  return (
    <Link to="/" className="whitespace-nowrap font-semibold tracking-tight transition-opacity hover:opacity-80">
      TWS <span className="text-muted-foreground">Panel</span>
    </Link>
  );
}

/** Itens do menu — em linha (topo) ou empilhados (lateral). */
function NavItems({ vertical }: { vertical: boolean }) {
  // /mail/envios fica dentro de /mail: sem isto, "E-mail" ficaria marcado junto.
  const { pathname } = useLocation();
  const enviosOpen = pathname === "/mail/envios" || pathname.startsWith("/mail/envios/");
  return (
    <nav className={cn("flex gap-1 text-sm", vertical ? "flex-col" : "flex-wrap items-center")}>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              "rounded-md px-3 py-1.5 transition-colors",
              isActive && !(item.to === "/mail" && enviosOpen)
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
        >
          {item.label}
          {item.to === "/alerts" && <OpenAlertsBadge />}
        </NavLink>
      ))}
    </nav>
  );
}

function TopBar({ className }: { className?: string }) {
  // Em telas pequenas os itens não cabem numa linha: ficam atrás de "Menu".
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <header data-testid="nav-top" className={cn("sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md", className)}>
      <div className="container flex min-h-14 items-center gap-6 py-2">
        <Brand />
        <div className="hidden md:block">
          <NavItems vertical={false} />
        </div>
        <button
          type="button"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
        >
          {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />} Menu
        </button>
        <UserMenu />
      </div>
      {mobileOpen && (
        <div data-testid="nav-mobile" className="container border-t pb-3 pt-2 md:hidden">
          <NavItems vertical />
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t py-6">
      <p className="text-center text-xs text-muted-foreground">
        Powered by <span className="font-medium">TWS</span> · open-source (MIT)
      </p>
    </footer>
  );
}

/**
 * Casca do painel. O menu fica onde o operador escolheu em Configurações:
 * no topo (padrão), na lateral esquerda ou na lateral direita. Em telas
 * pequenas a lateral não cabe — o menu volta ao topo.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { preferences } = useAuth();
  const side = preferences.navLayout;

  if (side === "top") {
    return (
      <div className="min-h-screen bg-background">
        <TopBar />
        <main className="container max-w-5xl py-8">{children}</main>
        <Footer />
      </div>
    );
  }

  const sidebar = (
    <aside
      data-testid="nav-sidebar"
      data-side={side}
      className={cn(
        "sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 bg-background px-3 py-5 md:flex",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <div className="px-3">
        <Brand />
      </div>
      <div className="flex-1 overflow-y-auto">
        <NavItems vertical />
      </div>
      <UserMenu placement={side === "left" ? "sidebar-left" : "sidebar-right"} />
    </aside>
  );

  return (
    <div className="min-h-screen bg-background">
      <TopBar className="md:hidden" />
      <div className="flex">
        {side === "left" && sidebar}
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="container max-w-5xl flex-1 py-8">{children}</main>
          <Footer />
        </div>
        {side === "right" && sidebar}
      </div>
    </div>
  );
}
