import { useEffect, useId, useRef, useState } from "react";
import { CircleHelp, ExternalLink } from "lucide-react";
import type { PanelVersionResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { bugReportUrl, discussionsUrl, docsUrl, featureRequestUrl, helpPageUrl, safeVersion } from "@/lib/links";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/**
 * "Ajuda e feedback": ícone discreto no cabeçalho (ao lado do idioma e do menu
 * do usuário) que abre um painel com links para o guia, a página de ajuda do
 * site, as Discussions e os formulários de bug e de sugestão. Fica fora do
 * menu do usuário de propósito: o menu do usuário é da conta (senha, 2FA,
 * sair) e a ajuda deve estar a um clique mesmo para quem nem sabe onde fica a
 * conta. Mesmo comportamento dos outros menus: Esc devolve o foco ao botão,
 * clique fora ou foco que sai do grupo fecham — assim nunca há dois abertos.
 *
 * Os endereços vêm de lib/links.ts. A versão do painel é consultada uma vez,
 * na primeira abertura, e só ela (e o idioma) entra no link do bug.
 */
export function HelpMenu({ placement = "top" }: { placement?: "top" | "sidebar-left" | "sidebar-right" }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const requested = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  // versão do painel: uma consulta só, na primeira abertura; se falhar, segue sem ela
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    apiFetch<PanelVersionResponse>("/api/version").then(
      (res) => setVersion(safeVersion(res?.version)),
      () => undefined,
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const links = [
    { href: docsUrl(locale), label: t("shell.help.docs") },
    { href: helpPageUrl(locale), label: t("shell.help.site") },
    { href: discussionsUrl(), label: t("shell.help.discussions") },
    { href: bugReportUrl({ version, locale }), label: t("shell.help.bug") },
    { href: featureRequestUrl(), label: t("shell.help.feature") },
  ];

  return (
    <div
      ref={containerRef}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
      onBlur={(event) => {
        // o foco foi para fora do grupo (ex.: menu do usuário): fecha, sem sobrepor
        const to = event.relatedTarget as Node | null;
        if (to && containerRef.current && !containerRef.current.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("shell.help.button")}
        title={t("shell.help.button")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <CircleHelp className="h-4 w-4" aria-hidden />
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={t("shell.help.button")}
          className={cn(
            "absolute z-50 w-72 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
            placement === "top" && "right-0 top-full mt-1",
            placement === "sidebar-left" && "bottom-full left-0 mb-1",
            placement === "sidebar-right" && "bottom-full right-0 mb-1",
          )}
        >
          <ul className="flex flex-col">
            {links.map((link) => (
              <li key={link.label}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span>
                    {link.label}
                    <span className="sr-only"> {t("shell.help.newTab")}</span>
                  </span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-1 border-t px-2 pb-1 pt-2 text-xs text-muted-foreground">{t("shell.help.logsWarning")}</p>
          {version && <p className="px-2 pb-1 text-xs text-muted-foreground">{t("shell.help.version", { version })}</p>}
        </div>
      )}
    </div>
  );
}
