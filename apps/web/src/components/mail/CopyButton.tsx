import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";

/**
 * Botão de copiar. Copia exatamente `text`; o ícone vira um "copiado" (✓)
 * por 1,5 s. `ariaLabel` diz o que é copiado para quem usa leitor de tela.
 */
export function CopyButton({ text, label, ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    await copyText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1_500);
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(!label && "h-7 w-7 shrink-0 p-0")}
      onClick={() => void copy()}
      title={copied ? "Copiado" : (ariaLabel ?? label ?? "Copiar")}
      aria-label={ariaLabel}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}
