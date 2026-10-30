import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Contagem de modais abertos: a rolagem da página só volta quando o último fecha.
let openCount = 0;
let savedOverflow = "";

function lockBodyScroll() {
  if (openCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openCount += 1;
}

function unlockBodyScroll() {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) document.body.style.overflow = savedOverflow;
}

// Pilha de modais abertos: só o do topo reage ao Escape.
const stack: symbol[] = [];

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const BusyContext = createContext<((delta: 1 | -1) => void) | null>(null);

/**
 * Um filho (ex.: "Criar na Cloudflare") avisa o diálogo que há uma operação em andamento:
 * enquanto `busy`, Escape e clique fora não fecham, para o resultado não se perder.
 */
export function useModalBusy(busy: boolean): void {
  const report = useContext(BusyContext);
  useEffect(() => {
    if (!busy || !report) return;
    report(1);
    return () => report(-1);
  }, [busy, report]);
}

/**
 * Diálogo que sempre cabe na tela: o painel nunca passa de 100% da altura visível
 * (dvh, para não esconder botões atrás da barra do navegador no celular), o
 * cabeçalho e o rodapé de ações ficam fixos e só o miolo rola.
 * Trava a rolagem da página enquanto está aberto e a devolve ao desmontar
 * (fechar por Escape, clique fora, botão ou sucesso). Foco: vai para o primeiro campo ao abrir,
 * fica preso no diálogo (Tab/Shift+Tab) e volta a quem o tinha ao fechar.
 * Com `busy` (ou um filho em useModalBusy) Escape e clique fora são ignorados.
 */
export function Modal({
  title,
  footer,
  onClose,
  busy = false,
  children,
  className,
}: {
  title: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const downOnOverlay = useRef(false);
  const [childBusy, setChildBusy] = useState(0);
  const locked = busy || childBusy > 0;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const reportBusy = useRef((delta: 1 | -1) => setChildBusy((n) => Math.max(0, n + delta))).current;

  useEffect(() => {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = bodyRef.current?.querySelector<HTMLElement>("input:not([disabled]),select:not([disabled]),textarea:not([disabled])");
    (first ?? panelRef.current)?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const id = Symbol("modal");
    stack.push(id);
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (stack[stack.length - 1] !== id || lockedRef.current) return;
      onCloseRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);

  function trapTab(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      panelRef.current.focus();
      return;
    }
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === firstEl || active === panelRef.current)) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  return (
    <BusyContext.Provider value={reportBusy}>
      <div
        data-testid="modal-overlay"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
        onMouseDown={(e) => {
          downOnOverlay.current = e.target === e.currentTarget;
        }}
        onMouseUp={(e) => {
          const clean = downOnOverlay.current && e.target === e.currentTarget;
          downOnOverlay.current = false;
          if (clean && !lockedRef.current) onCloseRef.current();
        }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={locked || undefined}
          data-testid="modal-panel"
          onKeyDown={trapTab}
          className={cn(
            "flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)]",
            className,
          )}
        >
          <div id={titleId} className="shrink-0 border-b px-4 py-3 text-base font-semibold sm:px-6">
            {title}
          </div>
          <div ref={bodyRef} data-testid="modal-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {children}
          </div>
          {footer && <div className="shrink-0 border-t px-4 py-3 sm:px-6">{footer}</div>}
        </div>
      </div>
    </BusyContext.Provider>
  );
}
