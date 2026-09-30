import { useEffect, useState } from "react";
import type { Project } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { CheckCircle2, Info, Loader2, Plus, Trash2, Variable } from "lucide-react";

interface EnvVar {
  key: string;
  value: string;
}

interface ComposeVariable {
  name: string;
  required: boolean;
  defaultValue: string | null;
}

/**
 * Seção Variáveis: variáveis de ambiente do projeto (DATABASE_URL, chaves de
 * API…). Guardadas cifradas no servidor; valem a partir do próximo deploy.
 * Valores escondidos por padrão (olho para mostrar).
 */
export function ProjectEnvCard({ project }: { project: Project }) {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  // O que o compose do projeto interpola (null = não é compose)
  const [composeVars, setComposeVars] = useState<ComposeVariable[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ vars: EnvVar[]; compose?: { variables: ComposeVariable[] } | null }>(`/api/projects/${project.id}/env`)
      .then((r) => {
        setVars(r.vars);
        setComposeVars(r.compose?.variables ?? null);
      })
      .catch((err: unknown) => {
        setVars([]);
        setError(err instanceof ApiRequestError ? err.message : "Não foi possível carregar as variáveis.");
      });
  }, [project.id]);

  function update(i: number, patch: Partial<EnvVar>) {
    setSaved(false);
    setVars((prev) => (prev ?? []).map((v, j) => (j === i ? { ...v, ...patch } : v)));
  }

  async function save() {
    if (!vars) return;
    setBusy(true);
    setError(null);
    try {
      const clean = vars.filter((v) => v.key.trim() !== "");
      const res = await apiFetch<{ vars: EnvVar[] }>(`/api/projects/${project.id}/env`, {
        method: "PUT",
        body: JSON.stringify({ vars: clean }),
      });
      setVars(res.vars);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }

  const staticSite = project.detection?.type === "static" || project.detection?.type === "static-node";
  const defined = new Set((vars ?? []).filter((v) => v.value !== "").map((v) => v.key.trim()));
  const listed = new Set((vars ?? []).map((v) => v.key.trim()));
  const missing = (composeVars ?? []).filter((v) => v.required && !defined.has(v.name));

  function addMissing() {
    setSaved(false);
    setVars((prev) => [
      ...(prev ?? []),
      ...missing.filter((v) => !listed.has(v.name)).map((v) => ({ key: v.name, value: "" })),
    ]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Variable className="h-4 w-4" /> Variáveis de ambiente
        </CardTitle>
        <CardDescription>
          Configurações e segredos que o app lê ao rodar (ex.: DATABASE_URL, API_KEY). Ficam cifradas no servidor e nunca
          aparecem nos logs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {staticSite && (
          <p data-testid="env-static-note" className="flex items-start gap-2 text-sm text-amber-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Este projeto é um site estático: não há servidor rodando para ler variáveis. Elas valem para projetos com
            Dockerfile ou docker-compose.
          </p>
        )}
        {composeVars && composeVars.length > 0 && (
          <div data-testid="compose-vars" className="flex flex-col gap-2 rounded-md border bg-secondary/20 p-3 text-xs">
            <p className="text-muted-foreground">
              O compose deste projeto usa estas variáveis
              {missing.length > 0 ? (
                <>
                  {" "}— <strong className="text-red-400">{missing.length} obrigatória(s) ainda sem valor</strong>: o deploy
                  falha sem elas.
                </>
              ) : (
                "."
              )}
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {composeVars.map((v) => {
                const ok = defined.has(v.name);
                return (
                  <li
                    key={v.name}
                    data-testid={`cv-${v.name}`}
                    className={cn(
                      "rounded border px-2 py-0.5 font-mono",
                      ok
                        ? "border-emerald-500/40 text-emerald-300"
                        : v.required
                          ? "border-red-500/40 text-red-300"
                          : "text-muted-foreground",
                    )}
                  >
                    {v.name}{" "}
                    <span className="font-sans">
                      {ok ? "· definida" : v.required ? "· obrigatória" : v.defaultValue !== null ? `· padrão: ${v.defaultValue || "vazio"}` : "· opcional"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {missing.some((v) => !listed.has(v.name)) && (
              <Button size="sm" variant="outline" className="self-start" onClick={addMissing}>
                <Plus className="h-3.5 w-3.5" /> Adicionar as que faltam
              </Button>
            )}
          </div>
        )}
        {vars === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <>
            {vars.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma variável ainda.</p>}
            <ul className="flex flex-col gap-2">
              {vars.map((v, i) => (
                <li key={i} className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={v.key}
                    onChange={(e) => update(i, { key: e.target.value })}
                    placeholder="NOME_DA_VARIAVEL"
                    className="font-mono sm:w-64"
                    aria-label={`Nome da variável ${i + 1}`}
                  />
                  <div className="flex flex-1 gap-2">
                    <PasswordInput
                      value={v.value}
                      onChange={(e) => update(i, { value: e.target.value })}
                      placeholder="valor"
                      autoComplete="off"
                      spellCheck={false}
                      className="font-mono"
                      containerClassName="flex-1"
                      aria-label={`Valor da variável ${i + 1}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remover ${v.key || "variável"}`}
                      onClick={() => {
                        setSaved(false);
                        setVars((prev) => (prev ?? []).filter((_, j) => j !== i));
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSaved(false);
                  setVars((prev) => [...(prev ?? []), { key: "", value: "" }]);
                }}
              >
                <Plus className="h-4 w-4" /> Adicionar variável
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar variáveis
              </Button>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> Salvas. Valem a partir do próximo deploy.
                </span>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
