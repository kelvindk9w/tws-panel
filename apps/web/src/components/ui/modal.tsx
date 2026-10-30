import { useEffect, useId, type ReactNode } from "react";
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

/**
 * Diálogo que sempre cabe na tela: o painel nunca passa de 100% da altura visível
 * (dvh, para não esconder botões atrás da barra do navegador no celular), o
 * cabeçalho e o rodapé de ações ficam fixos e só o miolo rola.
 * Trava a rolagem da página enquanto está aberto e a devolve ao desmontar
 * (fechar por Escape, clique fora, botão ou sucesso).
 */
export function Modal({
  title,
  footer,
  onClose,
  children,
  className,
}: {
  title: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();

  useEffect(() => {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="modal-panel"
        className={cn(
          "flex max-h-[calc(100dvh-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl sm:max-h-[calc(100dvh-2rem)]",
          className,
        )}
      >
        <div id={titleId} className="shrink-0 border-b px-4 py-3 text-base font-semibold sm:px-6">
          {title}
        </div>
        <div data-testid="modal-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {children}
        </div>
        {footer && <div className="shrink-0 border-t px-4 py-3 sm:px-6">{footer}</div>}
      </div>
    </div>
  );
}
