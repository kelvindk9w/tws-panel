import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router";
import type { AlertListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { UserMenu } from "@/components/UserMenu";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects/new", label: "Novo Projeto" },
  { to: "/mail", label: "E-mail" },
  { to: "/security", label: "Segurança" },
  { to: "/alerts", label: "Alertas" },
  { to: "/audit", label: "Auditoria" },
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
    const timer = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (openCount === 0) return null;
  return (
    <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-bold text-red-400">
      {openCount > 99 ? "99+" : openCount}
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container flex h-14 items-center gap-6">
          <Link to="/" className="font-semibold tracking-tight">
            TWS <span className="text-muted-foreground">Panel</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 transition-colors",
                    isActive
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
          <UserMenu />
        </div>
      </header>

      <main className="container max-w-5xl py-8">{children}</main>

      <footer className="border-t py-6">
        <p className="text-center text-xs text-muted-foreground">
          Powered by <span className="font-medium">TWS</span> · open-source (MIT)
        </p>
      </footer>
    </div>
  );
}
