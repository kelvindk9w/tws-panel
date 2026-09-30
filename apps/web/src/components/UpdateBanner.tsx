import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Intervalo entre conferências de versão (a aba visível também confere ao voltar). */
const CHECK_INTERVAL_MS = 60_000;

const BUNDLE_RE = /\/assets\/index-[\w-]+\.js/;

/** Arquivo principal (com hash do build) que esta aba carregou; null em desenvolvimento. */
function loadedBundle(): string | null {
  for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>("script[type=module][src]"))) {
    const m = BUNDLE_RE.exec(s.getAttribute("src") ?? "");
    if (m) return m[0];
  }
  return null;
}

/** Arquivo principal que o servidor entrega agora; null se não deu para saber. */
async function servedBundle(): Promise<string | null> {
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return null;
    return BUNDLE_RE.exec(await res.text())?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Aviso de "nova versão do painel". Depois de atualizar o painel (git pull +
 * docker compose up --build), a aba aberta seguia com o JavaScript antigo até
 * o operador descobrir o Ctrl+Shift+R (visto na validação real). O nome do
 * arquivo principal muda a cada build: se o servidor passou a entregar outro,
 * a aba está desatualizada.
 */
export function UpdateBanner({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    const current = loadedBundle();
    if (!current) return; // desenvolvimento (Vite): sem build com hash
    let cancelled = false;
    async function check() {
      const served = await servedBundle();
      if (!cancelled && served !== null && served !== current) setOutdated(true);
    }
    void check();
    const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!outdated) return null;
  return (
    <div
      data-testid="update-banner"
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-3 border-t border-sky-500/40 bg-sky-950/95 px-4 py-3 text-sm text-sky-100"
    >
      <span>Uma nova versão do painel foi instalada. Recarregue para usar a versão atual.</span>
      <Button size="sm" onClick={onReload}>
        <RefreshCw className="h-3.5 w-3.5" /> Recarregar
      </Button>
    </div>
  );
}
