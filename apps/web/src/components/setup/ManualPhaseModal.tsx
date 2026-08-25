import type { SecurityManualCommandsResponse } from "@paas/core";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, TerminalSquare, X } from "lucide-react";

interface ManualPhaseModalProps {
  /** Título legível da fase (ex.: "Fase 02 — Hardening de SSH"). */
  title: string;
  /** Comandos/notas da fase (null enquanto carrega da API). */
  data: SecurityManualCommandsResponse | null;
  /** Revarredura pós-execução manual em andamento. */
  verifying: boolean;
  /** true quando o último scan já confirmou a fase como satisfeita. */
  satisfied: boolean;
  onRescan: () => void;
  onClose: () => void;
}

/**
 * Modal "Fazer manualmente" (plano de correção do wizard de segurança).
 *
 * Mostra o passo a passo COPIÁVEL da fase para o operador executar por conta
 * própria no servidor (ou no terminal embutido) + o botão
 * "Já executei — revarrer", que re-roda o scan e valida a fase.
 */
export function ManualPhaseModal({ title, data, verifying, satisfied, onRescan, onClose }: ManualPhaseModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Execução manual — ${title}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold">
              <TerminalSquare className="h-5 w-5 text-muted-foreground" />
              Fazer manualmente — {title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Rode os comandos abaixo no servidor, na ordem (pelo SSH ou pelo terminal embutido do
              painel). Depois clique em <strong>Já executei — revarrer</strong> para o painel validar
              a fase.
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" onClick={onClose} aria-label="Fechar janela">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {satisfied && (
          <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
            ✅ Esta fase já está verificada como concluída no último scan.
          </p>
        )}

        {!data ? (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando o passo a passo…
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Passo a passo — comandos exatos (copie e execute um por um):
              </p>
              {data.commands.map((cmd) => (
                <div
                  key={cmd}
                  className="flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5"
                >
                  <code className="break-all font-mono text-xs text-emerald-100/90">{cmd}</code>
                  <CopyButton text={cmd} />
                </div>
              ))}
              {data.notes.map((n) => (
                <p key={n} className="text-xs text-amber-300/90">
                  ℹ️ {n}
                </p>
              ))}
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Ver o script completo da fase ({data.script})
              </summary>
              <div className="relative mt-1">
                <div className="absolute right-1 top-1">
                  <CopyButton text={data.scriptContent} />
                </div>
                <pre className="max-h-64 overflow-auto rounded bg-black/60 p-2 font-mono text-[11px] text-emerald-100/70">
                  {data.scriptContent}
                </pre>
              </div>
            </details>
          </>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
          <Button onClick={onRescan} disabled={verifying || !data}>
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Já executei — revarrer
          </Button>
        </div>
        {satisfied && <Badge variant="success" className="w-fit">✅ verificado no último scan</Badge>}
      </div>
    </div>
  );
}
