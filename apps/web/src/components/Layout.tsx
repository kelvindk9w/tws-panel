import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { ChevronDown, Languages, Menu, X } from "lucide-react";
import type { AlertListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LanguageSelect } from "@/components/LanguageSelect";
import { UserMenu } from "@/components/UserMenu";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/i18n";
import type { Key } from "@/i18n";

type NavItem = { to: string; label: Key; end?: boolean; more?: boolean };

/**
 * Todas as rotas do menu, na ordem. No topo, os marcados com `more` ficam
 * atrás do item "Mais" (uso menos diário); na lateral e no menu móvel há
 * espaço, então todos aparecem em lista.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "shell.nav.dashboard", end: true },
  { to: "/projects/new", label: "shell.nav.newProject" },
  { to: "/mail", label: "shell.nav.mail" },
  { to: "/mail/envios", label: "shell.nav.sending", more: true },
  { to: "/certificates", label: "shell.nav.certificates", more: true },
  { to: "/security", label: "shell.nav.security" },
  { to: "/alerts", label: "shell.nav.alerts" },
  { to: "/audit", label: "shell.nav.audit", more: true },
  { to: "/settings", label: "shell.nav.settings", more: true },
  { to: "/setup", label: "shell.nav.setup", more: true },
];

const linkClass = "whitespace-nowrap rounded-md px-3 py-1.5 transition-colors";
const linkActive = "bg-secondary text-foreground";
const linkIdle = "text-muted-foreground hover:bg-accent hover:text-foreground";

/** A rota do item (ou uma subrota dela) está aberta? */
function isUnder(to: string, pathname: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

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

/**
 * Item "Mais" do menu do topo: botão que abre uma lista com os itens menos
 * usados. Fecha com Esc (devolvendo o foco ao botão), clique fora, troca de
 * rota ou quando o foco sai do grupo; seta para baixo abre e percorre a lista.
 */
function MoreMenu({ items, enviosOpen }: { items: NavItem[]; enviosOpen: boolean }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // ao abrir pelo teclado, qual ponta da lista recebe o foco
  const [focusEdge, setFocusEdge] = useState<"first" | "last" | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const active = items.some((item) => isUnder(item.to, pathname));

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  useEffect(() => {
    if (open && focusEdge) {
      const links = panelRef.current?.querySelectorAll<HTMLElement>("a");
      if (links?.length) links[focusEdge === "first" ? 0 : links.length - 1]?.focus();
    }
    setFocusEdge(null);
  }, [open, focusEdge]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    const down = event.key === "ArrowDown";
    const up = event.key === "ArrowUp";
    if (!down && !up && !(open && (event.key === "Home" || event.key === "End"))) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      setFocusEdge(up ? "last" : "first");
      return;
    }
    const links = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("a") ?? []);
    const at = links.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = links.length - 1;
    else if (at === -1) next = down ? 0 : links.length - 1; // foco no botão
    else next = (at + (down ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const to = event.relatedTarget as Node | null;
        if (to && containerRef.current && !containerRef.current.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="nav-more-panel"
        data-active={active ? "true" : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(linkClass, "flex items-center gap-1", active ? linkActive : linkIdle)}
      >
        {t("shell.nav.more")}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div
          id="nav-more-panel"
          ref={panelRef}
          className="absolute left-0 top-full z-50 mt-1 flex w-56 flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {items.map((item) => (
            <NavEntry key={item.to} item={item} enviosOpen={enviosOpen} onNavigate={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavEntry({ item, enviosOpen, onNavigate }: { item: NavItem; enviosOpen: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(linkClass, isActive && !(item.to === "/mail" && enviosOpen) ? linkActive : linkIdle)
      }
    >
      {t(item.label)}
      {item.to === "/alerts" && <OpenAlertsBadge />}
    </NavLink>
  );
}

/**
 * Itens do menu. Em linha (topo): os de uso diário à vista e o resto em
 * "Mais". Empilhados (lateral e móvel): todos, sem agrupar.
 */
function NavItems({ vertical }: { vertical: boolean }) {
  const { t } = useI18n();
  // /mail/envios fica dentro de /mail: sem isto, "E-mail" ficaria marcado junto.
  const { pathname } = useLocation();
  const enviosOpen = isUnder("/mail/envios", pathname);
  const shown = vertical ? NAV_ITEMS : NAV_ITEMS.filter((item) => !item.more);
  return (
    <nav aria-label={t("shell.nav.label")} className={cn("flex gap-1 text-sm", vertical ? "flex-col" : "items-center")}>
      {shown.map((item) => (
        <NavEntry key={item.to} item={item} enviosOpen={enviosOpen} />
      ))}
      {!vertical && <MoreMenu items={NAV_ITEMS.filter((item) => item.more)} enviosOpen={enviosOpen} />}
    </nav>
  );
}

function TopBar({ className }: { className?: string }) {
  const { t } = useI18n();
  // Em telas pequenas os itens não cabem numa linha: ficam atrás de "Menu".
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <header data-testid="nav-top" className={cn("sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md", className)}>
      <div className="container flex min-h-14 items-center gap-3 py-2 sm:gap-4 xl:gap-6">
        <Brand />
        <div className="hidden lg:block">
          <NavItems vertical={false} />
        </div>
        <button
          type="button"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
        >
          {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />} {t("shell.nav.menu")}
        </button>
        {/* idioma sempre à vista, ao lado do menu do usuário */}
        <div className="ml-auto flex items-center gap-2">
          <LanguageSelect compact />
          <UserMenu />
        </div>
      </div>
      {mobileOpen && (
        <div data-testid="nav-mobile" className="container border-t pb-3 pt-2 lg:hidden">
          <NavItems vertical />
        </div>
      )}
    </header>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="border-t py-6">
      <p className="text-center text-xs text-muted-foreground">
        {t("shell.footer.poweredBy")} <span className="font-medium">TWS</span> · {t("shell.footer.license")}
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
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 px-3">
          <Languages className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <LanguageSelect className="min-w-0 flex-1" />
        </div>
        <UserMenu placement={side === "left" ? "sidebar-left" : "sidebar-right"} />
      </div>
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
