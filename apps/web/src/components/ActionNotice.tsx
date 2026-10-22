import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export type NoticeTone = "success" | "warning" | "error";

const TONES: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  success: { box: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100", icon: "text-emerald-400", Icon: CheckCircle2 },
  warning: { box: "border-amber-500/40 bg-amber-500/10 text-amber-100", icon: "text-amber-400", Icon: Info },
  error: { box: "border-red-500/40 bg-red-500/10 text-red-200", icon: "text-red-400", Icon: AlertTriangle },
};

/**
 * Aviso do resultado de uma ação (sucesso, atenção ou erro). Fica na tela até
 * ser fechado ou substituído — nunca some sozinho. O erro tem role="alert"; os
 * demais devem ser renderizados dentro de uma região role="status" que já
 * exista na página (ver `NoticeRegion`; vazia ela fica só `sr-only`, nunca display:none, para continuar na árvore de acessibilidade), para o leitor de tela anunciar.
 */
export function ActionNotice({
  tone,
  title,
  children,
  action,
  onDismiss,
  testId = "action-notice",
}: {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss: () => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const { box, icon, Icon } = TONES[tone];
  // visível sem rolar: se a página estiver rolada, traz o aviso para a tela
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <div
      ref={ref}
      role={tone === "error" ? "alert" : undefined}
      data-testid={testId}
      className={cn("flex items-start gap-2 rounded-md border p-3 text-sm", box)}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1 whitespace-pre-line break-words">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? "opacity-90" : undefined}>{children}</div>}
        {action && (
          <Button variant="outline" size="sm" className="mt-2" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label={t("common.dismissNotice")}
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** Região anunciada por leitor de tela; precisa existir antes do aviso entrar. */
export function NoticeRegion({ children }: { children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="empty:sr-only">
      {children}
    </div>
  );
}
