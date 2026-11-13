import { useEffect, useId, useRef, useState } from "react";
import { Bot, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildAgentInstructions } from "@/lib/agent-instructions";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/** Quanto tempo o botão mostra "Instruções copiadas" antes de voltar ao normal. */
export const COPIED_FEEDBACK_MS = 3000;

type State = "idle" | "copied" | "failed";

/**
 * "Copiar instruções para o agente": copia o texto de lib/agent-instructions.ts
 * (no idioma da interface, montado na hora do clique — trocar o idioma muda o
 * texto). A confirmação aparece no próprio botão e é anunciada numa região
 * `status` para leitor de tela. Se nem a API de clipboard nem o método antigo
 * funcionarem (página sem HTTPS, navegador que bloqueia), o texto aparece numa
 * caixa só de leitura, já focada e selecionada, para copiar à mão.
 *
 * `variant="menu"` é o item do menu de Ajuda; `variant="button"` é o botão da
 * tela de novo projeto.
 */
export function CopyAgentInstructions({ variant = "button", className }: { variant?: "button" | "menu"; className?: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<State>("idle");
  const [manualText, setManualText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const areaId = useId();
  // o menu de Ajuda fecha (e desmonta o botão) enquanto a cópia ainda está em andamento
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // sem cópia automática: a caixa recebe o foco já com tudo selecionado (Ctrl+C e pronto)
  useEffect(() => {
    if (state !== "failed") return;
    areaRef.current?.focus();
    areaRef.current?.select();
  }, [state]);

  async function copy() {
    const text = buildAgentInstructions(t, locale);
    if (timer.current) clearTimeout(timer.current);
    const ok = await copyText(text);
    if (!mounted.current) return; // nada de temporizador nem estado depois de sair da tela
    if (ok) {
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
    } else {
      setManualText(text);
      setState("failed");
    }
  }

  const copied = state === "copied";
  const label = copied ? t("agent.copy.copied") : t("agent.copy.button");
  const icon = copied ? (
    <Check className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
  ) : (
    <Bot className="h-4 w-4 shrink-0" aria-hidden />
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {variant === "menu" ? (
        <button
          type="button"
          onClick={() => void copy()}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {icon}
          <span>{label}</span>
        </button>
      ) : (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void copy()}>
          {icon}
          {label}
        </Button>
      )}
      <span role="status" className="sr-only">
        {copied ? t("agent.copy.status") : ""}
      </span>
      {state === "failed" && (
        <div className={cn("flex flex-col gap-1.5", variant === "menu" && "px-2 pb-1")}>
          <p role="alert" className="text-xs text-amber-800 dark:text-amber-300">
            {t("agent.copy.failed")}
          </p>
          <label htmlFor={areaId} className="sr-only">
            {t("agent.copy.manualLabel")}
          </label>
          <textarea
            id={areaId}
            ref={areaRef}
            readOnly
            value={manualText}
            rows={variant === "menu" ? 6 : 10}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}
