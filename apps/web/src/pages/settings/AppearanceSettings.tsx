import { useState } from "react";
import type { NavLayout, UpdatePreferencesResponse, UserPreferences } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Loader2 } from "lucide-react";

const NAV_OPTIONS: Array<{ value: NavLayout; label: string; hint: string }> = [
  { value: "top", label: "Topo", hint: "Como um site: o menu numa faixa no alto da página." },
  { value: "left", label: "Lateral esquerda", hint: "Como um sistema: o menu numa coluna à esquerda." },
  { value: "right", label: "Lateral direita", hint: "O menu numa coluna à direita." },
];

/** Miniatura do formato — mostra, sem precisar ler, onde o menu vai ficar. */
function LayoutPreview({ value }: { value: NavLayout }) {
  const bar = "rounded-sm bg-muted-foreground/60";
  const body = "rounded-sm bg-muted-foreground/20";
  return (
    <div aria-hidden className="flex h-16 w-24 gap-1 rounded border bg-background p-1">
      {value === "top" ? (
        <div className="flex flex-1 flex-col gap-1">
          <div className={cn(bar, "h-2.5")} />
          <div className={cn(body, "flex-1")} />
        </div>
      ) : (
        <>
          {value === "left" && <div className={cn(bar, "w-5")} />}
          <div className={cn(body, "flex-1")} />
          {value === "right" && <div className={cn(bar, "w-5")} />}
        </>
      )}
    </div>
  );
}

/**
 * Configurações → Aparência: onde fica o menu de navegação. A escolha vale na
 * hora e fica salva na conta (vale em qualquer computador).
 */
export function AppearanceSettings() {
  const { preferences, setPreferences } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(navLayout: NavLayout) {
    if (navLayout === preferences.navLayout || saving) return;
    const before: UserPreferences = preferences;
    setPreferences({ ...preferences, navLayout }); // muda na hora
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await apiFetch<UpdatePreferencesResponse>("/api/settings/preferences", {
        method: "PUT",
        body: JSON.stringify({ navLayout }),
      });
      setPreferences(res.preferences);
      setSaved(true);
    } catch (err) {
      setPreferences(before);
      setError(
        `Não foi possível salvar a escolha — o menu voltou ao que era.${
          err instanceof ApiRequestError && err.message ? ` (${err.message})` : ""
        }`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Aparência</CardTitle>
          <CardDescription>Onde fica o menu de navegação. Em telas pequenas, ele fica sempre no topo.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Menu de navegação" className="grid gap-3 sm:grid-cols-3">
            {NAV_OPTIONS.map((opt) => {
              const checked = preferences.navLayout === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={opt.label}
                  onClick={() => void choose(opt.value)}
                  className={cn(
                    "flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors",
                    checked ? "border-primary bg-secondary" : "hover:bg-accent",
                  )}
                >
                  <LayoutPreview value={opt.value} />
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs text-muted-foreground">{opt.hint}</span>
                </button>
              );
            })}
          </div>
          <div className="min-h-5 text-xs">
            {saving && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Salvando…
              </span>
            )}
            {saved && !saving && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> Salvo na sua conta.
              </span>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
